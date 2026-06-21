/**
 * app-preview-tools.ts — run and proxy local app previews.
 *
 * This is intentionally not a general shell. It only runs package-manager
 * install commands with lifecycle scripts disabled, then starts a workspace-local
 * Nx dev target with fixed argv. The public preview is served through DevSpace
 * so ChatGPT can iframe it from the same origin as the MCP app widget.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";
import { detectPackageManager, type PackageManager } from "./package-tools.js";

export interface StartAppPreviewInput {
  path: string;
  projectName?: string;
  install?: boolean;
  packageManager?: PackageManager;
  timeoutMs?: number;
}

export interface StartAppPreviewResult {
  previewId: string;
  title: string;
  previewUrl: string;
  localUrl: string;
  workspaceRoot: string;
  projectName: string;
  packageManager: PackageManager;
  port: number;
  command: string;
  args: string[];
  installed: boolean;
  installExitCode: number | null;
  ready: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface PreviewProcess {
  previewId: string;
  workspaceRoot: string;
  projectName: string;
  port: number;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  startedAt: number;
}

export class AppPreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPreviewError";
  }
}

function previewIdFor(workspaceRoot: string, projectName: string): string {
  const raw = `${workspaceRoot}:${projectName}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app"}-${(hash >>> 0).toString(16)}`;
}

function publicBase(config: AppConfig): string {
  return (config.publicBaseUrl ?? `http://${config.host}:${config.port}`).replace(/\/+$/, "");
}

function scrubbedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    NX_INTERACTIVE: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    ...extra,
  };
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new AppPreviewError("Could not allocate a preview port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function readPackageName(cwd: string): Promise<string> {
  const raw = await readFile(join(cwd, "package.json"), "utf8");
  const data = JSON.parse(raw) as { name?: unknown };
  if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
  throw new AppPreviewError("package.json is missing a package name; pass projectName explicitly");
}

function installCommand(packageManager: PackageManager): { command: string; args: string[] } {
  switch (packageManager) {
    case "npm":
      return { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] };
    case "pnpm":
      return { command: "corepack", args: ["pnpm", "install", "--ignore-scripts"] };
    case "yarn":
      return { command: "corepack", args: ["yarn", "install", "--mode=skip-build"] };
    case "bun":
      return { command: "bun", args: ["install", "--ignore-scripts"] };
  }
}

function nxBinaryName(): string {
  return process.platform === "win32" ? "nx.cmd" : "nx";
}

async function localNxBinary(cwd: string): Promise<string | null> {
  return realpath(join(cwd, "node_modules", ".bin", nxBinaryName())).catch(() => null);
}

function appendLog(current: string, chunk: Buffer, cap: number): string {
  const next = current + chunk.toString("utf8");
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function killTree(child: ChildProcess): void {
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    /* already gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

async function runBuffered(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  cap: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout = appendLog(stdout, c, cap);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = appendLog(stderr, c, cap);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AppPreviewError(`Failed to start ${command}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, stdout, stderr });
    });
  });
}

async function waitUntilReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function rewritePreviewText(body: string, previewPath: string): string {
  return body
    .replace(/(["'])\/_next\//g, `$1${previewPath}_next/`)
    .replace(/url\(\s*\/_next\//g, `url(${previewPath}_next/`);
}

export class AppPreviewManager {
  private readonly previews = new Map<string, PreviewProcess>();
  private latestPreviewId: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly guard: PathGuard,
  ) {}

  async start(ws: Workspace, input: StartAppPreviewInput): Promise<StartAppPreviewResult> {
    if (!this.config.enableAppScaffold) {
      throw new AppPreviewError("App preview is disabled (set ENABLE_APP_SCAFFOLD=1 to enable).");
    }

    const startedAt = Date.now();
    const workspaceRoot = await this.guard.resolveForRead(ws.root, input.path);
    const st = await stat(workspaceRoot).catch(() => null);
    if (!st?.isDirectory()) throw new AppPreviewError(`Preview path is not a directory: ${input.path}`);
    if (!(await exists(join(workspaceRoot, "package.json"))) || !(await exists(join(workspaceRoot, "nx.json")))) {
      throw new AppPreviewError("App preview path must contain package.json and nx.json");
    }

    const projectName = input.projectName ?? await readPackageName(workspaceRoot);
    const packageManager = input.packageManager ?? await detectPackageManager(workspaceRoot);
    const previewId = previewIdFor(workspaceRoot, projectName);
    const existing = this.previews.get(previewId);
    if (existing && !existing.child.killed && existing.child.exitCode === null) {
      this.latestPreviewId = previewId;
      const previewUrl = `${publicBase(this.config)}/app-previews/${encodeURIComponent(previewId)}/`;
      return {
        previewId,
        title: projectName,
        previewUrl,
        localUrl: `http://127.0.0.1:${existing.port}/`,
        workspaceRoot,
        projectName,
        packageManager,
        port: existing.port,
        command: "reuse",
        args: [],
        installed: false,
        installExitCode: null,
        ready: true,
        stdout: existing.stdout,
        stderr: existing.stderr,
        durationMs: Date.now() - startedAt,
      };
    }

    let installed = false;
    let installExitCode: number | null = null;
    let installStdout = "";
    let installStderr = "";
    let nxBin = await localNxBinary(workspaceRoot);
    const shouldInstall = input.install ?? !nxBin;
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 180_000, 10_000), 300_000);
    if (shouldInstall) {
      if (packageManager === "yarn" && !(await exists(join(workspaceRoot, "yarn.lock")))) {
        await writeFile(join(workspaceRoot, "yarn.lock"), "", { flag: "wx" }).catch(() => undefined);
      }
      const install = installCommand(packageManager);
      const result = await runBuffered(install.command, install.args, workspaceRoot, timeoutMs, this.config.shellMaxOutputBytes);
      installed = true;
      installExitCode = result.exitCode;
      installStdout = result.stdout;
      installStderr = result.stderr;
      if (result.exitCode !== 0) {
        throw new AppPreviewError(
          `Dependency install failed: ${install.command} ${install.args.join(" ")}\n${result.stderr || result.stdout}`,
        );
      }
      nxBin = await localNxBinary(workspaceRoot);
    }
    if (!nxBin) throw new AppPreviewError("Local Nx binary not found after install");

    const port = await freePort();
    const args = ["dev", projectName, "--hostname=127.0.0.1", `--port=${port}`];
    const child = spawn(nxBin, args, {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv({ PORT: String(port), HOSTNAME: "127.0.0.1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const preview: PreviewProcess = {
      previewId,
      workspaceRoot,
      projectName,
      port,
      child,
      stdout: installStdout,
      stderr: installStderr,
      startedAt,
    };
    child.stdout.on("data", (c: Buffer) => {
      preview.stdout = appendLog(preview.stdout, c, this.config.shellMaxOutputBytes);
    });
    child.stderr.on("data", (c: Buffer) => {
      preview.stderr = appendLog(preview.stderr, c, this.config.shellMaxOutputBytes);
    });
    child.on("exit", () => {
      if (this.previews.get(previewId)?.child === child) this.previews.delete(previewId);
    });
    child.on("error", (err) => {
      preview.stderr = appendLog(preview.stderr, Buffer.from(err.message), this.config.shellMaxOutputBytes);
    });
    this.previews.set(previewId, preview);
    this.latestPreviewId = previewId;

    const localUrl = `http://127.0.0.1:${port}/`;
    const ready = await waitUntilReady(localUrl, Math.min(timeoutMs, 120_000));
    if (!ready) {
      const stderr = preview.stderr;
      killTree(child);
      this.previews.delete(previewId);
      throw new AppPreviewError(`Preview server did not become ready in time.\n${stderr || preview.stdout}`);
    }

    return {
      previewId,
      title: projectName,
      previewUrl: `${publicBase(this.config)}/app-previews/${encodeURIComponent(previewId)}/`,
      localUrl,
      workspaceRoot,
      projectName,
      packageManager,
      port,
      command: nxBin,
      args,
      installed,
      installExitCode,
      ready,
      stdout: preview.stdout,
      stderr: preview.stderr,
      durationMs: Date.now() - startedAt,
    };
  }

  async proxyPreview(previewId: string, req: Request, res: Response, path = ""): Promise<void> {
    const preview = this.previews.get(previewId);
    if (!preview || preview.child.exitCode !== null) {
      res.status(404).type("text/plain").send("Preview is not running");
      return;
    }
    await this.proxyTo(preview, req, res, path);
  }

  async proxyLatestAsset(req: Request, res: Response, path: string): Promise<void> {
    const preview = this.latestPreviewId ? this.previews.get(this.latestPreviewId) : null;
    if (!preview || preview.child.exitCode !== null) {
      res.status(404).type("text/plain").send("No active preview for /_next asset");
      return;
    }
    await this.proxyTo(preview, req, res, `_next/${path}`);
  }

  private async proxyTo(preview: PreviewProcess, req: Request, res: Response, path: string): Promise<void> {
    const upstreamPath = `/${path || ""}`;
    const upstreamUrl = new URL(upstreamPath, `http://127.0.0.1:${preview.port}`);
    const originalUrl = req.originalUrl.split("?")[1];
    if (originalUrl) upstreamUrl.search = originalUrl;

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        "accept": req.headers.accept ?? "*/*",
        "user-agent": req.headers["user-agent"] ?? "DevSpacePreviewProxy",
      },
      redirect: "manual",
    });
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) return;
      res.setHeader(key, value);
    });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || contentType.includes("javascript")) {
      const base = `/app-previews/${encodeURIComponent(preview.previewId)}/`;
      res.send(rewritePreviewText(await upstream.text(), base));
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  }

  closeAll(): void {
    for (const preview of this.previews.values()) killTree(preview.child);
    this.previews.clear();
  }
}
