/**
 * package-tools.ts — constrained package installation.
 *
 * This is deliberately separate from run_command. Package installation is useful
 * for generated React/Next/Nx work, but package managers execute downloaded
 * code during lifecycle scripts by default. The tool therefore accepts structured
 * package names only and injects the package-manager flag that disables install
 * scripts unless a future operator-controlled policy says otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface InstallPackagesInput {
  path?: string;
  packages: string[];
  devDependency?: boolean;
  packageManager?: PackageManager;
}

export interface InstallPackagesResult {
  packageManager: PackageManager;
  command: string;
  args: string[];
  packages: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class PackageInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageInstallError";
  }
}

const PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^*<>=-]+)?$/;
const MANAGER_BINS: Record<PackageManager, string> = {
  npm: "npm",
  pnpm: "pnpm",
  yarn: "yarn",
  bun: "bun",
};

function packageManagerCommand(packageManager: PackageManager): string {
  if (packageManager === "pnpm" || packageManager === "yarn") return "corepack";
  return MANAGER_BINS[packageManager];
}

function validatePackages(packages: string[]): string[] {
  if (packages.length === 0) throw new PackageInstallError("packages must not be empty");
  if (packages.length > 30) throw new PackageInstallError("packages is limited to 30 entries");
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (!PACKAGE_RE.test(pkg)) {
      throw new PackageInstallError(
        `Invalid package spec "${pkg}". Use npm package names only, e.g. react, @scope/pkg, react@latest, react@18.2.0.`,
      );
    }
    if (seen.has(pkg)) throw new PackageInstallError(`Duplicate package spec: ${pkg}`);
    seen.add(pkg);
  }
  return packages;
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

async function readPackageManagerField(cwd: string): Promise<PackageManager | null> {
  const packageJsonPath = join(cwd, "package.json");
  const raw = await readFile(packageJsonPath, "utf8").catch(() => null);
  if (!raw) return null;
  const data = JSON.parse(raw) as { packageManager?: unknown };
  const value = typeof data.packageManager === "string" ? data.packageManager : "";
  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("yarn@")) return "yarn";
  if (value.startsWith("bun@")) return "bun";
  if (value.startsWith("npm@")) return "npm";
  return null;
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const fromPackageJson = await readPackageManagerField(cwd);
  if (fromPackageJson) return fromPackageJson;
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(join(cwd, "bun.lock")) || await fileExists(join(cwd, "bun.lockb"))) return "bun";
  if (await fileExists(join(cwd, "package-lock.json")) || await fileExists(join(cwd, "npm-shrinkwrap.json"))) return "npm";
  if (await fileExists(join(cwd, "package.json"))) return "npm";
  throw new PackageInstallError(`No package.json found in ${cwd}`);
}

export function installArgs(
  packageManager: PackageManager,
  packages: string[],
  devDependency: boolean,
): string[] {
  switch (packageManager) {
    case "npm":
      return ["install", "--ignore-scripts", devDependency ? "--save-dev" : "--save", ...packages];
    case "pnpm":
      return ["pnpm", "add", "--ignore-scripts", ...(devDependency ? ["-D"] : []), ...packages];
    case "yarn":
      return ["yarn", "add", "--mode=skip-builds", ...(devDependency ? ["--dev"] : []), ...packages];
    case "bun":
      return ["add", "--ignore-scripts", ...(devDependency ? ["--dev"] : []), ...packages];
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
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export async function installPackages(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: InstallPackagesInput,
): Promise<InstallPackagesResult> {
  if (!config.enablePackageInstall) {
    throw new PackageInstallError("Package installation is disabled (set ENABLE_PACKAGE_INSTALL=1 to enable).");
  }
  const packages = validatePackages(input.packages);
  const cwd = await guard.resolveForRead(ws.root, input.path ?? ".");
  const st = await stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new PackageInstallError(`Install path is not a directory: ${input.path ?? "."}`);
  if (basename(cwd) === ".git") throw new PackageInstallError("Refusing to install inside .git");
  if (!(await fileExists(join(cwd, "package.json")))) {
    throw new PackageInstallError(`No package.json found in ${input.path ?? "."}`);
  }

  const packageManager = input.packageManager ?? await detectPackageManager(cwd);
  const command = packageManagerCommand(packageManager);
  const args = installArgs(packageManager, packages, input.devDependency ?? false);
  const startedAt = Date.now();

  return await new Promise<InstallPackagesResult>((resolveResult, reject) => {
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
      reject(new PackageInstallError(`Failed to start ${command}: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        packageManager,
        command,
        args,
        packages,
        cwd,
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
