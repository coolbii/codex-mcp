import { afterEach, expect, it } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { SiteManager } from "../src/site-tools.js";
import { PathGuard } from "../src/path-guard.js";
import { CASE_INSENSITIVE_FS } from "../src/path-util.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

const silent = (): void => {};

function manager(projectsRoot?: string): SiteManager {
  const cfg = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      ...(projectsRoot ? { PROJECTS_ROOT: projectsRoot } : {}),
      OWNER_TOKEN: "x".repeat(40),
      PUBLIC_BASE_URL: "https://devspace.example.test",
    },
    warn: silent,
  });
  return new SiteManager(cfg, fx.guard);
}

it("creates a versioned static site with a public preview URL", async () => {
  fx = await makeFixture();
  const sites = manager();

  const site = await sites.createSite({ title: "Landing Page", prompt: "A focused landing page" });

  expect(site.siteId).toMatch(/^landing-page-/);
  expect(site.previewUrl).toBe(`https://devspace.example.test/sites/${site.siteId}/`);
  expect(site.versions).toHaveLength(1);
  expect(site.latestVersion).toBe(site.versions[0]?.version);

  const preview = await sites.previewFile(site.siteId, "");
  expect(basename(preview.absolutePath!)).toBe("index.html");
  expect(preview.contentType).toMatch(/text\/html/);
  await expect(readFile(preview.absolutePath!, "utf8")).resolves.toContain("Landing Page");
});

it("creates an archetype-based site without custom HTML", async () => {
  fx = await makeFixture();
  const sites = manager();

  const site = await sites.createSite({
    title: "Ops Console",
    prompt: "Internal operations workspace",
    archetype: "internal-dashboard",
  });

  expect(site.archetype).toBe("internal-dashboard");
  const preview = await sites.previewFile(site.siteId, "");
  const html = await readFile(preview.absolutePath!, "utf8");
  expect(html).toContain("Operations console");
  expect(html).toContain("app-shell");
});

it("commits each meaningful site update", async () => {
  fx = await makeFixture();
  const sites = manager();
  const created = await sites.createSite({ title: "Docs", prompt: "Docs site" });

  const updated = await sites.updateSite({
    siteId: created.siteId,
    message: "Change headline",
    html: "<!doctype html><title>Docs v2</title><h1>Docs v2</h1>",
  });

  expect(updated.versions).toHaveLength(2);
  expect(updated.versions[0]?.message).toBe("Change headline");
});

it("normalizes incomplete model-provided HTML into a complete document", async () => {
  fx = await makeFixture();
  const sites = manager();
  const site = await sites.createSite({
    title: "Partial",
    prompt: "Recover from partial HTML",
    html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partial</title>',
  });

  const preview = await sites.previewFile(site.siteId, "");
  const html = await readFile(preview.absolutePath!, "utf8");
  expect(html).toContain("</head>");
  expect(html).toContain("<body>");
  expect(html).toContain("</body>");
  expect(html).toContain("</html>");
});

it("refuses path traversal when serving previews", async () => {
  fx = await makeFixture();
  const sites = manager();
  const site = await sites.createSite({ title: "Safe Site", prompt: "Safety" });

  await expect(sites.previewFile(site.siteId, "../.env")).rejects.toThrow(/traversal|escapes/i);
  await expect(sites.previewFile(site.siteId, ".git/config")).rejects.toThrow(/git/i);
});

// --- multi-file static projects + tags -------------------------------------

it("creates a multi-file static project and serves a nested page", async () => {
  fx = await makeFixture();
  const sites = manager();
  const project = await sites.createProject({
    title: "My Project",
    files: [
      { path: "index.html", content: "<!doctype html><title>Home</title><h1>Home</h1>" },
      { path: "styles.css", content: "body{color:#111}" },
      { path: "pages/about.html", content: "<!doctype html><title>About</title><h1>About</h1>" },
    ],
  });

  expect(project.siteId).toMatch(/^my-project-/);
  expect(project.versions).toHaveLength(1);
  const about = await sites.previewFile(project.siteId, "pages/about.html");
  await expect(readFile(about.absolutePath!, "utf8")).resolves.toContain("About");
});

it("updates a project: add, overwrite, and delete files across versions", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({
    title: "Edits",
    files: [
      { path: "index.html", content: "v1" },
      { path: "old.txt", content: "bye" },
    ],
  });

  const up = await sites.updateProject({
    siteId: p.siteId,
    message: "edit",
    files: [
      { path: "index.html", content: "v2" },
      { path: "new.txt", content: "hi" },
    ],
    deletions: ["old.txt"],
  });

  expect(up.versions).toHaveLength(2);
  const idx = await sites.previewFile(p.siteId, "index.html");
  await expect(readFile(idx.absolutePath!, "utf8")).resolves.toContain("v2");
  await expect(sites.previewFile(p.siteId, "old.txt")).rejects.toThrow();
  const nw = await sites.previewFile(p.siteId, "new.txt");
  await expect(readFile(nw.absolutePath!, "utf8")).resolves.toContain("hi");
});

it("tags a version and serves the tagged content by tag", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Tagged", files: [{ path: "index.html", content: "one" }] });

  const tagged = await sites.tagVersion({ siteId: p.siteId, tag: "v1" });
  expect(tagged.tags.map((t) => t.tag)).toContain("v1");

  await sites.updateProject({ siteId: p.siteId, message: "two", files: [{ path: "index.html", content: "two" }] });

  const byTag = await sites.previewFile(p.siteId, "index.html", "v1");
  expect(byTag.body?.toString("utf8")).toContain("one");
  const head = await sites.previewFile(p.siteId, "index.html");
  await expect(readFile(head.absolutePath!, "utf8")).resolves.toContain("two");
});

it("refuses to move an existing tag without force", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Tagmove", files: [{ path: "index.html", content: "a" }] });
  await sites.tagVersion({ siteId: p.siteId, tag: "rel" });
  await expect(sites.tagVersion({ siteId: p.siteId, tag: "rel" })).rejects.toThrow(/already exists/i);
  await expect(sites.tagVersion({ siteId: p.siteId, tag: "rel", force: true })).resolves.toBeTruthy();
});

it("rejects unsafe project file paths", async () => {
  fx = await makeFixture();
  const sites = manager();
  await expect(
    sites.createProject({ title: "Bad", files: [{ path: "../escape.txt", content: "x" }] }),
  ).rejects.toThrow(/segment/i);
  await expect(
    sites.createProject({ title: "Bad Abs", files: [{ path: "/etc/passwd", content: "x" }] }),
  ).rejects.toThrow(/absolute/i);
  await expect(
    sites.createProject({ title: "Bad Git", files: [{ path: ".git/hooks/pre-commit", content: "x" }] }),
  ).rejects.toThrow(/segment/i);
});

it("rejects unsafe tag names and bad version selectors", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Safe", files: [{ path: "index.html", content: "x" }] });
  await expect(sites.tagVersion({ siteId: p.siteId, tag: "-rf" })).rejects.toThrow(/tag/i);
  await expect(sites.tagVersion({ siteId: p.siteId, tag: "a..b" })).rejects.toThrow(/tag/i);
  await expect(sites.tagVersion({ siteId: p.siteId, tag: "bad name" })).rejects.toThrow(/tag/i);
  await expect(sites.previewFile(p.siteId, "index.html", "--upload-pack")).rejects.toThrow(/version/i);
});

it("routes project folders under PROJECTS_ROOT when configured", async () => {
  fx = await makeFixture();
  const projectsRoot = join(fx.root, "myprojects");
  await mkdir(projectsRoot, { recursive: true });
  const sites = manager(projectsRoot);
  const p = await sites.createProject({ title: "Routed", files: [{ path: "index.html", content: "hi" }] });
  expect(p.localPath.startsWith(projectsRoot)).toBe(true);
});

// --- security regressions: .git / git-config / metadata write bypass --------

it("rejects writing .git, git-config, and metadata files in a project", async () => {
  fx = await makeFixture();
  const sites = manager();
  await expect(
    sites.createProject({ title: "G1", files: [{ path: ".git/config", content: "x" }] }),
  ).rejects.toThrow(/segment/i);
  await expect(
    sites.createProject({ title: "G2", files: [{ path: ".gitattributes", content: "* diff=evil" }] }),
  ).rejects.toThrow(/reserved|git/i);
  await expect(
    sites.createProject({ title: "G3", files: [{ path: ".gitmodules", content: "x" }] }),
  ).rejects.toThrow(/reserved|git/i);
  await expect(
    sites.createProject({ title: "G4", files: [{ path: ".devspace-site.json", content: "x" }] }),
  ).rejects.toThrow(/reserved/i);
});

// The RCE was: on a case-insensitive volume ".GIT/config" hits the real
// .git/config (core.fsmonitor → code execution). Only meaningful where the FS
// folds case; on case-sensitive volumes ".GIT" is a distinct, harmless dir.
it.runIf(CASE_INSENSITIVE_FS)("rejects case-variant .GIT/config writes (RCE regression)", async () => {
  fx = await makeFixture();
  const sites = manager();
  await expect(
    sites.createProject({ title: "CI1", files: [{ path: ".GIT/config", content: '[core]\n\tfsmonitor="touch PWNED"\n' }] }),
  ).rejects.toThrow(/segment/i);
  await expect(
    sites.createProject({ title: "CI2", files: [{ path: ".Git/hooks/post-commit", content: "#!/bin/sh\n" }] }),
  ).rejects.toThrow(/segment/i);
  await expect(
    sites.createProject({ title: "CI3", files: [{ path: ".DEVSPACE-SITE.JSON", content: "x" }] }),
  ).rejects.toThrow(/reserved/i);
});

it("rejects deleting .git internals via update_project deletions", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Del", files: [{ path: "index.html", content: "x" }] });
  await expect(
    sites.updateProject({ siteId: p.siteId, message: "del", deletions: [".git/index"] }),
  ).rejects.toThrow(/segment/i);
  if (CASE_INSENSITIVE_FS) {
    await expect(
      sites.updateProject({ siteId: p.siteId, message: "del", deletions: [".GIT/HEAD"] }),
    ).rejects.toThrow(/segment/i);
  }
});

it.runIf(CASE_INSENSITIVE_FS)("rejects trailing-dot/space .git variants (Windows path fold)", async () => {
  fx = await makeFixture();
  const sites = manager();
  await expect(
    sites.createProject({ title: "TD1", files: [{ path: ".git./config", content: "x" }] }),
  ).rejects.toThrow(/segment/i);
  await expect(
    sites.createProject({ title: "TD2", files: [{ path: ".GIT /config", content: "x" }] }),
  ).rejects.toThrow(/segment/i);
});

it("404s reserved/meta/git-config files on the serve path", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Serve", files: [{ path: "index.html", content: "ok" }] });
  await expect(sites.previewFile(p.siteId, ".devspace-site.json")).rejects.toThrow(/reserved|git/i);
  await expect(sites.previewFile(p.siteId, ".gitattributes")).rejects.toThrow(/reserved|git/i);
});

it("refuses to create a project when the projects base is read-only", async () => {
  fx = await makeFixture();
  const projectsRoot = join(fx.root, "ro-projects");
  await mkdir(projectsRoot, { recursive: true });
  const cfg = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      PROJECTS_ROOT: projectsRoot,
      READONLY_ROOTS: projectsRoot, // the projects base itself is read-only
      OWNER_TOKEN: "x".repeat(40),
      PUBLIC_BASE_URL: "https://devspace.example.test",
    },
    warn: silent,
  });
  const guard = new PathGuard(cfg.allowedRoots, cfg.readonlyRoots);
  const sites = new SiteManager(cfg, guard);
  await expect(
    sites.createProject({ title: "X", files: [{ path: "index.html", content: "x" }] }),
  ).rejects.toThrow(/read-only/i);
});

it("marks commit-hash versions immutable but hex-shaped tags movable", async () => {
  fx = await makeFixture();
  const sites = manager();
  const p = await sites.createProject({ title: "Imm", files: [{ path: "index.html", content: "x" }] });
  const byHash = await sites.previewFile(p.siteId, "index.html", p.latestVersion!);
  expect(byHash.immutable).toBe(true);
  // A tag whose name LOOKS like a commit hash must still be treated as movable.
  await sites.tagVersion({ siteId: p.siteId, tag: "deadbeef" });
  const byTag = await sites.previewFile(p.siteId, "index.html", "deadbeef");
  expect(byTag.immutable).toBe(false);
});
