import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, relative, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { PathGuard, isInsideOrEqual } from "./path-guard.js";

const execFileAsync = promisify(execFile);
const SITE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const VERSION_RE = /^[0-9a-f]{7,40}$/;
export const SITE_ARCHETYPES = [
  "b2b-saas-quiet",
  "internal-dashboard",
  "product-docs",
  "editorial-product",
] as const;
export type SiteArchetype = (typeof SITE_ARCHETYPES)[number];

export interface SiteSummary {
  siteId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
  latestVersion: string | null;
  archetype?: SiteArchetype;
}

export interface SiteVersion {
  version: string;
  message: string;
  createdAt: string;
}

export interface SiteDetails extends SiteSummary {
  localPath: string;
  versions: SiteVersion[];
}

interface SiteMeta {
  siteId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archetype?: SiteArchetype;
}

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "site";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeSiteId(siteId: string): string {
  if (!SITE_ID_RE.test(siteId)) {
    throw new SiteError("siteId must be 3-64 chars: lowercase letters, numbers, and dashes only");
  }
  return siteId;
}

function normalizeVersion(version: string | undefined): string | null {
  if (!version) return null;
  if (!VERSION_RE.test(version)) throw new SiteError("version must be a git commit hash");
  return version;
}

function normalizeArchetype(value: string | undefined): SiteArchetype {
  if (!value) return "b2b-saas-quiet";
  if ((SITE_ARCHETYPES as readonly string[]).includes(value)) return value as SiteArchetype;
  throw new SiteError(`Unknown site archetype: ${value}`);
}

function defaultHtml(title: string, prompt: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <p class="eyebrow">DevSpace preview</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(prompt)}</p>
        <div class="actions">
          <a class="button primary" href="#content">Explore</a>
          <a class="button secondary" href="mailto:hello@example.com">Contact</a>
        </div>
      </section>
      <section id="content" class="grid">
        <article>
          <h2>Fast iteration</h2>
          <p>Describe a change in ChatGPT and DevSpace can rewrite this local preview.</p>
        </article>
        <article>
          <h2>Versioned locally</h2>
          <p>Every update becomes a git commit inside this generated site folder.</p>
        </article>
        <article>
          <h2>Shareable URL</h2>
          <p>The preview is served through your configured DevSpace public URL.</p>
        </article>
      </section>
    </main>
    <script src="./script.js"></script>
  </body>
</html>
`;
}

function fallbackBody(title: string, prompt: string): string {
  return `    <main class="shell">
      <section class="hero">
        <p class="eyebrow">DevSpace preview</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(prompt)}</p>
        <div class="actions">
          <a class="button primary" href="#content">Explore</a>
          <a class="button secondary" href="mailto:hello@example.com">Contact</a>
        </div>
      </section>
      <section id="content" class="grid">
        <article>
          <h2>Fast iteration</h2>
          <p>Describe a change in ChatGPT and DevSpace can rewrite this local preview.</p>
        </article>
        <article>
          <h2>Versioned locally</h2>
          <p>Every update becomes a git commit inside this generated site folder.</p>
        </article>
        <article>
          <h2>Shareable URL</h2>
          <p>The preview is served through your configured DevSpace public URL.</p>
        </article>
      </section>
    </main>`;
}

function normalizeHtmlDocument(html: string, title: string, prompt: string): string {
  let out = html.trim();
  if (!out) return defaultHtml(title, prompt);

  // Cloudflare may append scripts to served HTML. If the model left an
  // unterminated attribute like <meta name=", that injected script can become
  // part of the tag. Drop obviously corrupt meta tags before closing the doc.
  out = out.replace(/<meta\s+name=["']?\s*<script[\s\S]*?(?:<\/script>|$)/gi, "");

  if (!/<!doctype\s+html/i.test(out)) out = `<!doctype html>\n${out}`;
  if (!/<html[\s>]/i.test(out)) out += `\n<html lang="en">`;
  if (!/<head[\s>]/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<link rel="stylesheet" href="./styles.css">\n</head>`);
  }
  if (!/<title[\s>]/i.test(out)) {
    out = out.replace(/<\/head>/i, `<title>${escapeHtml(title)}</title>\n<link rel="stylesheet" href="./styles.css">\n</head>`);
  }
  if (!/<link[^>]+href=["']\.\/styles\.css["']/i.test(out)) {
    out = out.replace(/<\/head>/i, `<link rel="stylesheet" href="./styles.css">\n</head>`);
  }
  if (/<head[\s>]/i.test(out) && !/<\/head>/i.test(out)) {
    out += `\n</head>`;
  }
  if (!/<body[\s>]/i.test(out)) {
    out += `\n<body>\n${fallbackBody(title, prompt)}\n</body>`;
  } else if (!/<\/body>/i.test(out)) {
    out += `\n</body>`;
  }
  if (!/<\/html>/i.test(out)) out += `\n</html>`;
  return `${out}\n`;
}

const defaultCss = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f7f7f2;
  color: #17201b;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(120deg, rgba(35, 92, 91, 0.14), transparent 36%),
    linear-gradient(300deg, rgba(213, 92, 59, 0.12), transparent 34%),
    #f7f7f2;
}

a { color: inherit; }

.shell {
  width: min(1120px, calc(100% - 40px));
  margin: 0 auto;
  padding: 56px 0;
}

.hero {
  min-height: 58vh;
  display: grid;
  align-content: center;
  gap: 22px;
}

.eyebrow {
  margin: 0;
  color: #3f706b;
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

h1 {
  margin: 0;
  max-width: 820px;
  font-size: clamp(48px, 8vw, 92px);
  line-height: 0.96;
  letter-spacing: 0;
}

.lede {
  margin: 0;
  max-width: 680px;
  color: #42514a;
  font-size: 20px;
  line-height: 1.55;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 700;
}

.primary {
  background: #17201b;
  color: #fff;
}

.secondary {
  border: 1px solid rgba(23, 32, 27, 0.28);
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  padding-top: 28px;
}

article {
  padding: 22px;
  border: 1px solid rgba(23, 32, 27, 0.14);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.58);
}

article h2 {
  margin: 0 0 10px;
  font-size: 19px;
}

article p {
  margin: 0;
  color: #52635b;
  line-height: 1.55;
}

@media (max-width: 760px) {
  .shell {
    width: min(100% - 28px, 1120px);
    padding: 32px 0;
  }

  .grid {
    grid-template-columns: 1fr;
  }
}
`;

const defaultJs = `document.documentElement.dataset.ready = "true";
`;

interface SiteTemplate {
  html: string;
  css: string;
  js: string;
}

function templateFor(archetype: SiteArchetype, title: string, prompt: string): SiteTemplate {
  const safeTitle = escapeHtml(title);
  const safePrompt = escapeHtml(prompt);
  const commonJs = defaultJs;
  if (archetype === "internal-dashboard") {
    return {
      html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app-shell">
    <aside class="rail">
      <strong>${safeTitle}</strong>
      <nav><a href="#overview">Overview</a><a href="#queue">Queue</a><a href="#health">Health</a></nav>
    </aside>
    <section class="workspace">
      <header>
        <p class="eyebrow">Operations console</p>
        <h1>${safeTitle}</h1>
        <p>${safePrompt}</p>
      </header>
      <section id="overview" class="metrics">
        <article><span>Open risks</span><strong>12</strong><small>3 need owner review</small></article>
        <article><span>Cycle time</span><strong>2.8d</strong><small>Down 14% this week</small></article>
        <article><span>SLA health</span><strong>97%</strong><small>Within target range</small></article>
      </section>
      <section id="queue" class="table">
        <div><strong>Enterprise onboarding</strong><span>Alex</span><em>Today</em></div>
        <div><strong>Billing handoff</strong><span>Mina</span><em>Tomorrow</em></div>
        <div><strong>API incident review</strong><span>Sam</span><em>Friday</em></div>
      </section>
    </section>
  </main>
  <script src="./script.js"></script>
</body>
</html>`,
      css: dashboardCss,
      js: commonJs,
    };
  }
  if (archetype === "product-docs") {
    return {
      html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="docs">
    <nav><strong>${safeTitle}</strong><a href="#start">Start</a><a href="#concepts">Concepts</a><a href="#api">API</a></nav>
    <article>
      <p class="eyebrow">Product guide</p>
      <h1>${safeTitle}</h1>
      <p class="lede">${safePrompt}</p>
      <section id="start"><h2>Start with one workspace</h2><p>Connect the first workflow, define owners, and review the generated status model before rollout.</p></section>
      <section id="concepts"><h2>Core concepts</h2><p>Workspaces hold teams, queues hold work, and policies define escalation behavior.</p></section>
      <section id="api"><h2>API shape</h2><pre><code>POST /v1/workspaces
GET /v1/queues/:id/status</code></pre></section>
    </article>
  </main>
  <script src="./script.js"></script>
</body>
</html>`,
      css: docsCss,
      js: commonJs,
    };
  }
  if (archetype === "editorial-product") {
    return {
      html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main>
    <section class="feature">
      <p class="eyebrow">Field note</p>
      <h1>${safeTitle}</h1>
      <p>${safePrompt}</p>
    </section>
    <section class="story">
      <article><h2>Built around real usage</h2><p>Pages favor readable content blocks, quiet emphasis, and a steady rhythm over decorative effects.</p></article>
      <article><h2>Designed to be edited</h2><p>Every section is plain HTML and CSS, so future iterations stay inspectable.</p></article>
    </section>
  </main>
  <script src="./script.js"></script>
</body>
</html>`,
      css: editorialCss,
      js: commonJs,
    };
  }
  return {
    html: defaultHtml(title, prompt),
    css: defaultCss,
    js: commonJs,
  };
}

const dashboardCss = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201b;background:#eef1ee}*{box-sizing:border-box}body{margin:0}.app-shell{min-height:100vh;display:grid;grid-template-columns:240px 1fr}.rail{padding:24px;border-right:1px solid #d6ddd8;background:#f8faf8}.rail strong{display:block;margin-bottom:28px}.rail a{display:block;color:#52635b;text-decoration:none;padding:8px 0}.workspace{padding:32px;max-width:1120px}.eyebrow{margin:0 0 8px;color:#3f706b;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{margin:0;font-size:42px;line-height:1.05;letter-spacing:0}header p:last-child{max-width:680px;color:#52635b;line-height:1.6}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:28px 0}.metrics article,.table{border:1px solid #d6ddd8;border-radius:8px;background:#fff}.metrics article{padding:18px}.metrics span,.metrics small{display:block;color:#52635b}.metrics strong{display:block;font-size:36px;margin:8px 0}.table div{display:grid;grid-template-columns:1fr 140px 120px;gap:12px;padding:16px 18px;border-top:1px solid #eef1ee}.table div:first-child{border-top:0}.table span,.table em{color:#52635b;font-style:normal}@media(max-width:820px){.app-shell{grid-template-columns:1fr}.rail{border-right:0;border-bottom:1px solid #d6ddd8}.metrics{grid-template-columns:1fr}.table div{grid-template-columns:1fr}}`;

const docsCss = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201b;background:#fbfbf7}*{box-sizing:border-box}body{margin:0}.docs{display:grid;grid-template-columns:260px minmax(0,760px);gap:54px;max-width:1120px;margin:0 auto;padding:42px 24px}nav{position:sticky;top:24px;height:max-content}nav strong,nav a{display:block}nav strong{margin-bottom:22px}nav a{padding:8px 0;color:#52635b;text-decoration:none}.eyebrow{margin:0 0 12px;color:#7b4e2f;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{margin:0;font-size:52px;line-height:1.02;letter-spacing:0}.lede{font-size:20px;line-height:1.6;color:#52635b}section{padding:28px 0;border-top:1px solid #e1e3dc}h2{font-size:24px;margin:0 0 10px}p{line-height:1.65;color:#3d4b44}pre{padding:16px;border-radius:8px;background:#17201b;color:#f8faf8;overflow:auto}@media(max-width:820px){.docs{grid-template-columns:1fr;gap:24px}nav{position:static}h1{font-size:40px}}`;

const editorialCss = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#191d1b;background:#f4f0ea}*{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:0 auto;padding:64px 24px}.feature{min-height:56vh;display:grid;align-content:center}.eyebrow{margin:0 0 14px;color:#7b4e2f;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}h1{max-width:860px;margin:0;font-size:clamp(46px,8vw,86px);line-height:1;letter-spacing:0}.feature p:last-child{max-width:640px;font-size:20px;line-height:1.6;color:#4f5b55}.story{display:grid;grid-template-columns:1fr 1fr;gap:18px;border-top:1px solid #d8d0c4;padding-top:32px}article{padding:24px 0}h2{font-size:24px;margin:0 0 10px}article p{line-height:1.65;color:#4f5b55}@media(max-width:760px){.story{grid-template-columns:1fr}main{padding:36px 20px}}`;

export class SiteManager {
  readonly baseDir: string;

  constructor(
    private readonly config: AppConfig,
    private readonly guard: PathGuard,
  ) {
    const root = config.allowedRoots[0];
    if (!root) throw new SiteError("At least one allowed root is required for site previews");
    this.baseDir = resolve(root, "devspace-sites");
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const realBase = resolve(await realpath(this.baseDir));
    if (!this.guard.isWithinAllowedRoots(realBase)) {
      throw new SiteError(`Site base is outside allowed roots: ${this.baseDir}`);
    }
  }

  async createSite(input: {
    title: string;
    prompt: string;
    archetype?: SiteArchetype;
    html?: string;
    css?: string;
    js?: string;
  }): Promise<SiteDetails> {
    await this.ensureReady();
    const siteId = await this.uniqueSiteId(input.title);
    const dir = this.siteDir(siteId);
    await mkdir(dir, { recursive: false });

    const now = new Date().toISOString();
    const archetype = normalizeArchetype(input.archetype);
    const template = templateFor(archetype, input.title, input.prompt);
    const meta: SiteMeta = { siteId, title: input.title, createdAt: now, updatedAt: now, archetype };
    await writeFile(
      join(dir, "index.html"),
      normalizeHtmlDocument(input.html ?? template.html, input.title, input.prompt),
      "utf8",
    );
    await writeFile(join(dir, "styles.css"), input.css ?? template.css, "utf8");
    await writeFile(join(dir, "script.js"), input.js ?? template.js, "utf8");
    await writeFile(join(dir, ".devspace-site.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

    await this.git(dir, ["init"]);
    await this.git(dir, ["add", "index.html", "styles.css", "script.js", ".devspace-site.json"]);
    await this.git(dir, ["commit", "-m", `Create site: ${input.title}`]);
    return this.getSite(siteId);
  }

  async updateSite(input: {
    siteId: string;
    message: string;
    title?: string;
    html?: string;
    css?: string;
    js?: string;
  }): Promise<SiteDetails> {
    const siteId = safeSiteId(input.siteId);
    const dir = await this.checkedSiteDir(siteId);
    const meta = await this.readMeta(dir);
    const nextMeta: SiteMeta = {
      ...meta,
      title: input.title ?? meta.title,
      updatedAt: new Date().toISOString(),
    };

    if (input.html !== undefined) {
      await writeFile(join(dir, "index.html"), normalizeHtmlDocument(input.html, nextMeta.title, input.message), "utf8");
    }
    if (input.css !== undefined) await writeFile(join(dir, "styles.css"), input.css, "utf8");
    if (input.js !== undefined) await writeFile(join(dir, "script.js"), input.js, "utf8");
    await writeFile(join(dir, ".devspace-site.json"), JSON.stringify(nextMeta, null, 2) + "\n", "utf8");

    await this.git(dir, ["add", "index.html", "styles.css", "script.js", ".devspace-site.json"]);
    const changed = await this.hasStagedChanges(dir);
    if (changed) {
      await this.git(dir, ["commit", "-m", input.message]);
    }
    return this.getSite(siteId);
  }

  async listSites(): Promise<SiteSummary[]> {
    await this.ensureReady();
    const entries = await readdir(this.baseDir, { withFileTypes: true }).catch(() => []);
    const sites: SiteSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SITE_ID_RE.test(entry.name)) continue;
      try {
        const details = await this.getSite(entry.name);
        sites.push({
          siteId: details.siteId,
          title: details.title,
          createdAt: details.createdAt,
          updatedAt: details.updatedAt,
          previewUrl: details.previewUrl,
          latestVersion: details.latestVersion,
          ...(details.archetype ? { archetype: details.archetype } : {}),
        });
      } catch {
        // Ignore partial folders so one bad preview does not hide the rest.
      }
    }
    return sites.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSite(siteIdInput: string): Promise<SiteDetails> {
    const siteId = safeSiteId(siteIdInput);
    const dir = await this.checkedSiteDir(siteId);
    const meta = await this.readMeta(dir);
    const versions = await this.versions(dir);
    return {
      ...meta,
      localPath: dir,
      previewUrl: this.previewUrl(siteId),
      latestVersion: versions[0]?.version ?? null,
      versions,
    };
  }

  async previewFile(siteIdInput: string, filePathInput: string, versionInput?: string): Promise<{
    absolutePath: string;
    contentType: string;
  }> {
    const siteId = safeSiteId(siteIdInput);
    const version = normalizeVersion(versionInput);
    const dir = await this.checkedSiteDir(siteId);
    const filePath = filePathInput === "" || filePathInput.endsWith("/") ? `${filePathInput}index.html` : filePathInput;
    if (filePath.split(/[\\/]/).some((part) => part === ".git" || part === "..")) {
      throw new SiteError("Refusing to serve hidden git data or parent traversal");
    }
    if (/^([\\/]|[a-zA-Z]:)/.test(filePath)) {
      throw new SiteError("Refusing an absolute file path");
    }

    if (version) {
      await this.git(dir, ["cat-file", "-e", `${version}^{commit}`]);
      const tmpDir = join(this.baseDir, ".preview-cache", siteId, version);
      const target = resolve(tmpDir, filePath);
      // Mirror the non-version branch: the write/serve target must stay inside
      // the per-version cache dir.
      if (!isInsideOrEqual(target, tmpDir)) throw new SiteError("Path escapes preview cache");
      await mkdir(resolve(target, ".."), { recursive: true });
      const { stdout } = await this.git(dir, ["show", `${version}:${filePath}`], { encoding: "buffer" });
      await writeFile(target, stdout as Buffer);
      return { absolutePath: target, contentType: contentTypeFor(filePath) };
    }

    const target = resolve(dir, filePath);
    if (!isInsideOrEqual(target, dir)) throw new SiteError("Path escapes site");
    await access(target, fsConstants.R_OK);
    return { absolutePath: target, contentType: contentTypeFor(filePath) };
  }

  private async uniqueSiteId(title: string): Promise<string> {
    const stem = slugify(title);
    for (let i = 0; i < 20; i += 1) {
      const suffix = randomUUID().slice(0, 8);
      const siteId = `${stem}-${suffix}`.slice(0, 64).replace(/-+$/g, "");
      try {
        await access(this.siteDir(siteId));
      } catch {
        return safeSiteId(siteId);
      }
    }
    throw new SiteError("Could not allocate site id");
  }

  private siteDir(siteId: string): string {
    return resolve(this.baseDir, safeSiteId(siteId));
  }

  private async checkedSiteDir(siteId: string): Promise<string> {
    await this.ensureReady();
    const dir = this.siteDir(siteId);
    if (!isInsideOrEqual(dir, this.baseDir)) throw new SiteError("Site path escapes base directory");
    const st = await stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new SiteError(`Unknown site: ${siteId}`);
    return dir;
  }

  private async readMeta(dir: string): Promise<SiteMeta> {
    const raw = await readFile(join(dir, ".devspace-site.json"), "utf8");
    const meta = JSON.parse(raw) as SiteMeta;
    safeSiteId(meta.siteId);
    return meta;
  }

  private previewUrl(siteId: string): string {
    const base = this.config.publicBaseUrl ?? `http://${this.config.host}:${this.config.port}`;
    return `${base}/sites/${encodeURIComponent(siteId)}/`;
  }

  private async versions(dir: string): Promise<SiteVersion[]> {
    const { stdout } = await this.git(dir, [
      "log",
      "--pretty=format:%H%x09%cI%x09%s",
      "--max-count=50",
    ]);
    return String(stdout)
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [version, createdAt, ...messageParts] = line.split("\t");
        if (!version || !createdAt) return [];
        return [{ version, createdAt, message: messageParts.join("\t") }];
      });
  }

  private async hasStagedChanges(dir: string): Promise<boolean> {
    const result = await execFileAsync("git", ["diff", "--cached", "--quiet"], {
      cwd: dir,
      env: this.gitEnv(),
    }).catch((err: NodeJS.ErrnoException & { code?: number }) => err);
    return "code" in result && result.code === 1;
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "DevSpace",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "devspace@localhost",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "DevSpace",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "devspace@localhost",
    };
  }

  private async git(
    dir: string,
    args: string[],
    opts?: { encoding?: BufferEncoding | "buffer" },
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    const cwd = resolve(dir);
    if (!isInsideOrEqual(cwd, this.baseDir)) {
      throw new SiteError(`Refusing git outside site base: ${relative(this.baseDir, cwd)}`);
    }
    const result = await execFileAsync("git", args, {
      cwd,
      env: this.gitEnv(),
      maxBuffer: 8 * 1024 * 1024,
      encoding: opts?.encoding ?? "utf8",
    });
    return result as { stdout: string | Buffer; stderr: string | Buffer };
  }
}

function contentTypeFor(path: string): string {
  const leaf = basename(path).toLowerCase();
  if (leaf.endsWith(".html")) return "text/html; charset=utf-8";
  if (leaf.endsWith(".css")) return "text/css; charset=utf-8";
  if (leaf.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (leaf.endsWith(".json")) return "application/json; charset=utf-8";
  if (leaf.endsWith(".svg")) return "image/svg+xml";
  if (leaf.endsWith(".png")) return "image/png";
  if (leaf.endsWith(".jpg") || leaf.endsWith(".jpeg")) return "image/jpeg";
  if (leaf.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
