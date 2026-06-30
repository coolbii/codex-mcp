/**
 * openpencil-preview-tools.ts — proxy the native OpenPencil web/editor UI into
 * the ChatGPT preview iframe.
 *
 * This is separate from .op file operations. It exposes a capability URL with an
 * unguessable id and forwards it to the local OpenPencil web server.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";

interface OpenPencilPreview {
  previewId: string;
  port: number;
  localUrl: string;
  startedAt: number;
  stdout: string;
  stderr: string;
  child?: ChildProcess;
}

export interface OpenPencilPreviewResult {
  previewId: string;
  title: string;
  previewUrl: string;
  localUrl: string;
  port: number;
  ready: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class OpenPencilPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenPencilPreviewError";
  }
}

function publicBase(config: AppConfig): string {
  return (config.publicBaseUrl ?? `http://${config.host}:${config.port}`).replace(/\/+$/, "");
}

function newPreviewId(): string {
  return `openpencil-${randomBytes(16).toString("hex")}`;
}

function appendLog(current: string, chunk: Buffer, cap: number): string {
  const next = current + chunk.toString("utf8");
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function probeReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

interface OpenPencilStatusProbe {
  port: number;
  localUrl: string;
  stdout: string;
  stderr: string;
}

function isRecoverablePreviewId(previewId: string): boolean {
  return /^openpencil-[a-f0-9]{16,64}$/.test(previewId);
}

function parseStatus(stdout: string): { port: number; url?: string } | null {
  try {
    const parsed = JSON.parse(stdout) as { running?: unknown; port?: unknown; url?: unknown };
    if (parsed.running !== true || !Number.isInteger(parsed.port)) return null;
    const port = parsed.port as number;
    if (port < 1 || port > 65535) return null;
    return { port, ...(typeof parsed.url === "string" && parsed.url ? { url: parsed.url } : {}) };
  } catch {
    return null;
  }
}

function normalizeLocalUrl(status: { port: number; url?: string }): string {
  const raw = status.url ?? `http://127.0.0.1:${status.port}`;
  const parsed = new URL(raw);
  return `${parsed.origin}/`;
}

function runOpStatus(config: AppConfig): Promise<{ stdout: string; stderr: string }> {
  const cap = config.shellMaxOutputBytes;
  return new Promise((resolve) => {
    const child = spawn(config.openPencilCli, ["status"], {
      cwd: process.cwd(),
      shell: false,
      windowsHide: true,
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, 1_000);
    child.stdout?.on("data", (c: Buffer) => {
      stdout = appendLog(stdout, c, cap);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = appendLog(stderr, c, cap);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: appendLog(stderr, Buffer.from(err.message), cap) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

async function findRunningOpenPencil(config: AppConfig): Promise<OpenPencilStatusProbe | null> {
  const statusRun = await runOpStatus(config);
  const status = parseStatus(statusRun.stdout);
  if (!status) return null;
  const localUrl = normalizeLocalUrl(status);
  if (!(await probeReady(localUrl))) return null;
  return { port: status.port, localUrl, stdout: statusRun.stdout, stderr: statusRun.stderr };
}

async function waitForRunningOpenPencil(
  config: AppConfig,
  fallbackPort: number,
  timeoutMs: number,
): Promise<OpenPencilStatusProbe | null> {
  const deadline = Date.now() + timeoutMs;
  const fallbackUrl = `http://127.0.0.1:${fallbackPort}/`;
  while (Date.now() < deadline) {
    const status = await findRunningOpenPencil(config);
    if (status) return status;
    if (await probeReady(fallbackUrl)) {
      return { port: fallbackPort, localUrl: fallbackUrl, stdout: "", stderr: "" };
    }
    await delay(250);
  }
  return null;
}

function liveDocumentSyncBootstrap(basepath: string): string {
  const documentUrl = `${basepath}/api/mcp/document`;
  return `
;(() => {
  const DEVSPACE_OPENPENCIL_SYNC_URL = ${JSON.stringify(documentUrl)};
  const loadLiveDocument = async () => {
    try {
      if (typeof P === "undefined" || !P?.getState?.().loadDocument) return;
      const res = await fetch(DEVSPACE_OPENPENCIL_SYNC_URL, { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      const live = payload?.document;
      if (!live || typeof live !== "object") return;
      const state = P.getState();
      const current = state.document;
      const liveVersion = payload?.version;
      const liveRoot = live.pages?.[0]?.children?.[0]?.name ?? live.children?.[0]?.name;
      const currentRoot = current?.pages?.[0]?.children?.[0]?.name ?? current?.children?.[0]?.name;
      const loadedVersion = window.__DEVSPACE_OPENPENCIL_SYNC_VERSION;
      if (liveVersion !== undefined && loadedVersion === liveVersion) return;
      if (liveVersion === undefined && liveRoot && currentRoot === liveRoot) return;
      state.loadDocument(live, "Live OpenPencil", null, null);
      window.__DEVSPACE_OPENPENCIL_SYNC_VERSION = liveVersion;
      requestAnimationFrame(() => {
        try { typeof tt !== "undefined" && tt(); } catch {}
      });
    } catch (err) {
      console.debug("[devspace-openpencil-preview] live document sync skipped", err);
    }
  };
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", loadLiveDocument, { once: true });
  } else {
    setTimeout(loadLiveDocument, 0);
  }
  window.addEventListener("focus", loadLiveDocument);
})();`;
}

function injectLiveDocumentSync(body: string, basepath: string): string {
  if (body.includes("DEVSPACE_OPENPENCIL_SYNC_URL")) return body;
  if (!body.includes("applyExternalDocument") || !body.includes("loadDocument:")) return body;
  return `${body}\n${liveDocumentSyncBootstrap(basepath)}\n`;
}

function rewriteText(body: string, previewPath: string): string {
  const prefix = previewPath.endsWith("/") ? previewPath : `${previewPath}/`;
  const basepath = prefix.replace(/\/$/, "");
  const rewritten = body
    .replace(/\b(href|src|action)=(["'])\/(?!\/)([^"'#\s>]+)/g, `$1=$2${prefix}$3`)
    .replace(/\b(srcset)=(["'])\/(?!\/)([^"'>]+)/g, `$1=$2${prefix}$3`)
    .replace(/(import\(\s*["'])\/(?!\/)([^"']+)/g, `$1${prefix}$2`)
    .replace(/(["'])\/(assets\/[^"']+)/g, `$1${prefix}$2`)
    .replace(/(["'])\/(canvaskit\/[^"']*)/g, `$1${prefix}$2`)
    .replace(/(["'])\/(fonts\/[^"']*)/g, `$1${prefix}$2`)
    .replace(/url\(\s*(["']?)\/(?!\/)([^)'"\s>]+)/g, `url($1${prefix}$2`)
    .replace(
      /function\s+Xk\(\)\{return\s+window\.location\.origin\}/g,
      `function Xk(){return window.location.origin+${JSON.stringify(basepath)}}`,
    )
    .replace(/basepath:""/g, `basepath:${JSON.stringify(basepath)}`);
  return injectLiveDocumentSync(rewritten, basepath);
}

function bodyForUpstream(req: Request): RequestInit["body"] | undefined {
  if (["GET", "HEAD"].includes(req.method)) return undefined;
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === "string") return req.body;
    return JSON.stringify(req.body);
  }
  return req as unknown as ReadableStream;
}

function documentChildren(doc: unknown): unknown[] {
  if (!doc || typeof doc !== "object") return [];
  const root = doc as { pages?: unknown; children?: unknown };
  if (Array.isArray(root.pages)) {
    return root.pages.flatMap((page) => {
      if (!page || typeof page !== "object") return [];
      const children = (page as { children?: unknown }).children;
      return Array.isArray(children) ? children : [];
    });
  }
  return Array.isArray(root.children) ? root.children : [];
}

function countDocumentNodes(doc: unknown): number {
  const countNode = (node: unknown): number => {
    if (!node || typeof node !== "object") return 0;
    const children = (node as { children?: unknown }).children;
    const childCount = Array.isArray(children) ? children.reduce<number>((sum, child) => sum + countNode(child), 0) : 0;
    return 1 + childCount;
  };
  return documentChildren(doc).reduce<number>((sum, child) => sum + countNode(child), 0);
}

async function getUpstreamDocument(localUrl: string): Promise<unknown | null> {
  try {
    const res = await fetch(new URL("api/mcp/document", localUrl), { cache: "no-store", signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return null;
    const payload = (await res.json()) as { document?: unknown };
    return payload.document ?? null;
  } catch {
    return null;
  }
}

function isDefaultBlankDocumentPost(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const doc = (body as { document?: unknown }).document;
  if (!doc || typeof doc !== "object") return false;
  const roots = documentChildren(doc);
  if (roots.length !== 1) return false;
  const only = roots[0] as { type?: unknown; name?: unknown; children?: unknown };
  const childCount = Array.isArray(only.children) ? only.children.length : 0;
  return only.type === "frame" && only.name === "Frame" && childCount === 0;
}

async function destructiveDocumentShrinkReason(localUrl: string, body: unknown): Promise<string | null> {
  if (!body || typeof body !== "object") return null;
  const incoming = (body as { document?: unknown }).document;
  if (!incoming || typeof incoming !== "object") return null;
  const current = await getUpstreamDocument(localUrl);
  if (!current) return null;
  const currentCount = countDocumentNodes(current);
  const incomingCount = countDocumentNodes(incoming);
  if (currentCount >= 8 && incomingCount <= 2) return "near_empty_document";
  if (currentCount >= 20 && incomingCount < currentCount * 0.5) return "large_node_count_drop";
  return null;
}

export class OpenPencilPreviewManager {
  private readonly previews = new Map<string, OpenPencilPreview>();
  private latestPreviewId: string | null = null;

  constructor(private readonly config: AppConfig) {}

  private buildPreview(
    status: OpenPencilStatusProbe,
    startedAt: number,
    stdout: string,
    stderr: string,
    child?: ChildProcess,
  ): OpenPencilPreviewResult {
    const previewId = newPreviewId();
    const preview: OpenPencilPreview = {
      previewId,
      port: status.port,
      localUrl: status.localUrl,
      startedAt,
      stdout,
      stderr,
      ...(child ? { child } : {}),
    };
    this.previews.set(previewId, preview);
    this.latestPreviewId = previewId;
    const previewUrl = `${publicBase(this.config)}/openpencil-previews/${encodeURIComponent(previewId)}/editor`;
    return {
      previewId,
      title: "OpenPencil",
      previewUrl,
      localUrl: status.localUrl,
      port: status.port,
      ready: true,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  private restorePreview(previewId: string, status: OpenPencilStatusProbe): OpenPencilPreview {
    const preview: OpenPencilPreview = {
      previewId,
      port: status.port,
      localUrl: status.localUrl,
      startedAt: Date.now(),
      stdout: status.stdout,
      stderr: status.stderr,
    };
    this.previews.set(previewId, preview);
    this.latestPreviewId = previewId;
    return preview;
  }

  async attach(input: { timeoutMs?: number } = {}): Promise<OpenPencilPreviewResult> {
    if (!this.config.enableOpenPencil) {
      throw new OpenPencilPreviewError("OpenPencil bridge is disabled (set ENABLE_OPENPENCIL=1 to enable).");
    }
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new OpenPencilPreviewError("timeoutMs must be between 1000 and 300000");
    }

    const startedAt = Date.now();
    const ready = await waitForRunningOpenPencil(this.config, this.config.openPencilPreviewPort, timeoutMs);
    if (!ready) {
      throw new OpenPencilPreviewError("OpenPencil is not running. Start it first with `op start --desktop`.");
    }
    return this.buildPreview(ready, startedAt, ready.stdout, ready.stderr);
  }

  async start(input: { timeoutMs?: number } = {}): Promise<OpenPencilPreviewResult> {
    if (!this.config.enableOpenPencil) {
      throw new OpenPencilPreviewError("OpenPencil bridge is disabled (set ENABLE_OPENPENCIL=1 to enable).");
    }
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
      throw new OpenPencilPreviewError("timeoutMs must be between 1000 and 300000");
    }

    const startedAt = Date.now();
    const fallbackPort = this.config.openPencilPreviewPort;
    const alreadyReady = await waitForRunningOpenPencil(this.config, fallbackPort, 1_000);

    let child: ChildProcess | undefined;
    let stdout = alreadyReady?.stdout ?? "";
    let stderr = alreadyReady?.stderr ?? "";
    if (!alreadyReady) {
      child = spawn(this.config.openPencilCli, ["start", "--web"], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: scrubbedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (c: Buffer) => {
        stdout = appendLog(stdout, c, this.config.shellMaxOutputBytes);
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr = appendLog(stderr, c, this.config.shellMaxOutputBytes);
      });
      child.unref();
    }

    const ready = alreadyReady ?? await waitForRunningOpenPencil(this.config, fallbackPort, timeoutMs);
    if (!ready) {
      const details = [stdout.trim() ? `stdout: ${stdout.trim()}` : "", stderr.trim() ? `stderr: ${stderr.trim()}` : ""]
        .filter(Boolean)
        .join("\n");
      throw new OpenPencilPreviewError(
        `OpenPencil preview did not become ready. Start OpenPencil web/desktop first, or build the OpenPencil web runtime so \`op start --web\` can launch it.${details ? `\n${details}` : ""}`,
      );
    }

    return this.buildPreview(ready, startedAt, stdout, stderr, child);
  }

  async proxyPreview(previewId: string, req: Request, res: Response, path = ""): Promise<void> {
    let preview = this.previews.get(previewId);
    if (!preview && isRecoverablePreviewId(previewId)) {
      const status = await waitForRunningOpenPencil(this.config, this.config.openPencilPreviewPort, 1_000);
      if (status) preview = this.restorePreview(previewId, status);
    }
    if (!preview) throw new OpenPencilPreviewError("Unknown OpenPencil preview id");
    const upstreamPath = path || "editor";
    if (req.method === "POST" && upstreamPath === "api/mcp/document" && isDefaultBlankDocumentPost(req.body)) {
      res.status(200).json({ ok: true, ignored: true, reason: "default_blank_document" });
      return;
    }
    if (req.method === "POST" && upstreamPath === "api/mcp/document") {
      const reason = await destructiveDocumentShrinkReason(preview.localUrl, req.body);
      if (reason) {
        res.status(200).json({ ok: true, ignored: true, reason });
        return;
      }
    }
    const upstreamUrl = new URL(upstreamPath, preview.localUrl);
    upstreamUrl.search = new URL(req.url, "http://devspace.local").search;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    const init: RequestInit = { method: req.method, headers, redirect: "manual" };
    const upstreamBody = bodyForUpstream(req);
    if (upstreamBody !== undefined) {
      init.body = upstreamBody;
      init.duplex = "half";
    }

    const upstream = await fetch(upstreamUrl, init);
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) return;
      res.setHeader(key, value);
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const contentType = upstream.headers.get("content-type") ?? "";
    const base = `/openpencil-previews/${encodeURIComponent(preview.previewId)}/`;
    if (/text\/html|javascript|text\/css/.test(contentType)) {
      res.send(rewriteText(await upstream.text(), base));
      return;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  }

  latest(): OpenPencilPreview | null {
    return this.latestPreviewId ? this.previews.get(this.latestPreviewId) ?? null : null;
  }
}
