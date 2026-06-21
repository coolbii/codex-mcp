/**
 * app-tools.ts — constrained Nx app scaffolding.
 *
 * This is not a general shell. It only runs an Nx app generator in an opened
 * workspace that already looks like an Nx monorepo.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";
import { detectPackageManager, type PackageManager } from "./package-tools.js";

export type AppFramework = "next" | "react";

export interface CreateAppInput {
  path?: string;
  appName: string;
  framework: AppFramework;
  directory?: string;
  dryRun?: boolean;
  packageManager?: PackageManager;
}

export interface CreateAppResult {
  appName: string;
  framework: AppFramework;
  cwd: string;
  packageManager: PackageManager;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class CreateAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateAppError";
  }
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9-_]{1,63}$/;
const DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_./]{0,120}$/;

async function exists(path: string): Promise<boolean> {
  return Boolean(await access(path).then(() => true).catch(() => false));
}

async function assertNxWorkspace(cwd: string): Promise<void> {
  if (!(await exists(join(cwd, "package.json")))) throw new CreateAppError(`No package.json found in ${cwd}`);
  if (!(await exists(join(cwd, "nx.json")))) throw new CreateAppError(`No nx.json found in ${cwd}`);
}

function generatorFor(framework: AppFramework): string {
  if (framework === "next") return "@nx/next:app";
  return "@nx/react:app";
}

function nxBinaryName(): string {
  return process.platform === "win32" ? "nx.cmd" : "nx";
}

async function localNxBinary(cwd: string): Promise<string> {
  const nxBin = await realpath(join(cwd, "node_modules", ".bin", nxBinaryName())).catch(() => null);
  if (!nxBin) {
    throw new CreateAppError(
      "Local Nx binary not found at node_modules/.bin/nx. Run your package manager install first; create_app will not download Nx with npx/bunx.",
    );
  }
  return nxBin;
}

export function createAppCommand(
  nxBin: string,
  input: Pick<CreateAppInput, "appName" | "framework" | "directory" | "dryRun">,
): { command: string; args: string[] } {
  return {
    command: nxBin,
    args: [
      "g",
      generatorFor(input.framework),
      input.appName,
      "--no-interactive",
      ...(input.directory ? [`--directory=${input.directory}`] : []),
      ...(input.dryRun ? ["--dry-run"] : []),
    ],
  };
}

function validateInput(input: CreateAppInput): void {
  if (!NAME_RE.test(input.appName)) {
    throw new CreateAppError("appName must be 2-64 chars and use letters, numbers, dashes, or underscores");
  }
  if (input.directory) {
    if (!DIR_RE.test(input.directory) || input.directory.includes("..")) {
      throw new CreateAppError("directory must be a safe workspace-relative path without '..'");
    }
  }
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

function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = { CI: "1", NX_INTERACTIVE: "false" };
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export async function createApp(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: CreateAppInput,
): Promise<CreateAppResult> {
  if (!config.enableAppScaffold) {
    throw new CreateAppError("Nx app scaffolding is disabled (set ENABLE_APP_SCAFFOLD=1 to enable).");
  }
  validateInput(input);
  const cwd = await guard.resolveForRead(ws.root, input.path ?? ".");
  const st = await stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new CreateAppError(`App path is not a directory: ${input.path ?? "."}`);
  await assertNxWorkspace(cwd);

  const packageManager = input.packageManager ?? await detectPackageManager(cwd);
  const nxBin = await localNxBinary(cwd);
  const { command, args } = createAppCommand(nxBin, input);
  const startedAt = Date.now();

  return await new Promise<CreateAppResult>((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const cap = config.shellMaxOutputBytes;
    let outLen = 0;
    let errLen = 0;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, config.shellTimeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      if (outLen < cap) {
        outChunks.push(c);
        outLen += c.length;
        if (outLen >= cap) {
          truncated = true;
          killTree(child);
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      if (errLen < cap) {
        errChunks.push(c);
        errLen += c.length;
        if (errLen >= cap) truncated = true;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CreateAppError(`Failed to start ${command}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        appName: input.appName,
        framework: input.framework,
        cwd,
        packageManager,
        command,
        args,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        truncated,
        stdout: Buffer.concat(outChunks).subarray(0, cap).toString("utf8"),
        stderr: Buffer.concat(errChunks).subarray(0, cap).toString("utf8"),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
