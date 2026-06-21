/**
 * app-tools.ts — constrained Nx app scaffolding.
 *
 * This is not a general shell. It only runs an Nx app generator in an opened
 * workspace that already looks like an Nx monorepo, or writes a constrained
 * isolated Nx workspace template under an opened workspace.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./path-guard.js";
import { isInsideOrEqual } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";
import { detectPackageManager, type PackageManager } from "./package-tools.js";

export type AppFramework = "next" | "react";
export type CreateAppMode = "existing" | "isolated";

export interface CreateAppInput {
  path?: string;
  appName: string;
  framework: AppFramework;
  directory?: string;
  dryRun?: boolean;
  packageManager?: PackageManager;
  mode?: CreateAppMode;
}

export interface CreateAppResult {
  appName: string;
  framework: AppFramework;
  mode: CreateAppMode;
  cwd: string;
  workspaceRoot: string;
  generatedFiles: string[];
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

export function createIsolatedAppCommand(
  input: Pick<CreateAppInput, "appName" | "framework" | "directory" | "dryRun">,
): { command: string; args: string[] } {
  return {
    command: "devspace:create-isolated-app",
    args: [
      input.framework,
      input.appName,
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

function splitSafeRelativePath(input: string): string[] {
  if (!DIR_RE.test(input) || input.includes("..")) {
    throw new CreateAppError("directory must be a safe workspace-relative path without '..'");
  }
  return input.split(/[\\/]+/).filter(Boolean);
}

async function ensureDirectoryInside(
  baseDir: string,
  relativePath: string,
  guard: PathGuard,
  create: boolean,
): Promise<string> {
  const segments = splitSafeRelativePath(relativePath);
  let current = await realpath(baseDir);
  for (const segment of segments) {
    const next = join(current, segment);
    const existing = await lstat(next).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (existing?.isSymbolicLink()) {
      throw new CreateAppError(`Refusing to create inside a symlinked directory: ${relativePath}`);
    }
    if (existing && !existing.isDirectory()) {
      throw new CreateAppError(`Path is not a directory: ${relativePath}`);
    }
    if (!existing) {
      if (!create) {
        if (!isInsideOrEqual(next, baseDir) || !guard.isWithinAllowedRoots(current)) {
          throw new CreateAppError(`Directory escapes the workspace: ${relativePath}`);
        }
        current = next;
        continue;
      }
      await mkdir(next);
    }
    current = await realpath(next);
    if (!isInsideOrEqual(current, baseDir) || !guard.isWithinAllowedRoots(current)) {
      throw new CreateAppError(`Directory escapes the workspace: ${relativePath}`);
    }
  }
  return current;
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(cwd, "package.json"), "utf8").catch(() => "{}");
  return JSON.parse(raw) as Record<string, unknown>;
}

function packageVersion(pkg: Record<string, unknown>, name: string, fallback: string): string {
  const sections = ["dependencies", "devDependencies", "peerDependencies"] as const;
  for (const section of sections) {
    const deps = pkg[section];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      const value = (deps as Record<string, unknown>)[name];
      if (typeof value === "string") return value;
    }
  }
  return fallback;
}

function patchedNextVersion(versionSpec: string): string {
  const match = versionSpec.match(/^([~^]?)(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return versionSpec;
  const [, prefix, majorRaw, minorRaw, patchRaw, suffix] = match;
  if (suffix) return versionSpec;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  const below = (fixedMinor: number, fixedPatch: number) =>
    minor < fixedMinor || (minor === fixedMinor && patch < fixedPatch);

  if (major === 14 && below(2, 35)) return `${prefix}14.2.35`;
  if (major === 15) {
    const fixedByMinor: Record<number, number> = { 0: 7, 1: 11, 2: 8, 3: 8, 4: 10, 5: 9 };
    const fixedPatch = fixedByMinor[minor];
    if (fixedPatch !== undefined && patch < fixedPatch) return `${prefix}15.${minor}.${fixedPatch}`;
  }
  if (major === 16 && minor === 0 && patch < 10) return `${prefix}16.0.10`;
  return versionSpec;
}

function packageManagerField(parentPkg: Record<string, unknown>, packageManager: PackageManager): string | undefined {
  const value = parentPkg.packageManager;
  if (typeof value === "string" && value.startsWith(`${packageManager}@`)) return value;
  return undefined;
}

function nextWorkspaceFiles(appName: string, parentPkg: Record<string, unknown>, packageManager: PackageManager): Record<string, string> {
  const packageJson: Record<string, unknown> = {
    name: appName,
    version: "0.0.0",
    private: true,
    scripts: {
      dev: `nx dev ${appName}`,
      build: `nx build ${appName}`,
      start: `nx start ${appName}`,
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    dependencies: {
      next: patchedNextVersion(packageVersion(parentPkg, "next", "14.2.35")),
      react: packageVersion(parentPkg, "react", "18.3.1"),
      "react-dom": packageVersion(parentPkg, "react-dom", "18.3.1"),
    },
    devDependencies: {
      "@nx/next": packageVersion(parentPkg, "@nx/next", "^19.5.0"),
      "@nx/workspace": packageVersion(parentPkg, "@nx/workspace", "^19.5.0"),
      "@types/node": packageVersion(parentPkg, "@types/node", "^20.14.10"),
      "@types/react": packageVersion(parentPkg, "@types/react", "18.3.1"),
      "@types/react-dom": packageVersion(parentPkg, "@types/react-dom", "18.3.0"),
      nx: packageVersion(parentPkg, "nx", "19.5.0"),
      typescript: packageVersion(parentPkg, "typescript", "^5.5.3"),
    },
  };
  const pmField = packageManagerField(parentPkg, packageManager);
  if (pmField) packageJson.packageManager = pmField;

  return {
    "package.json": JSON.stringify(packageJson, null, 2) + "\n",
    "nx.json": `${JSON.stringify({
      $schema: "./node_modules/nx/schemas/nx-schema.json",
      namedInputs: {
        default: ["{projectRoot}/**/*"],
        production: ["default"],
      },
      targetDefaults: {
        build: {
          cache: true,
        },
      },
    }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "es2022"],
        allowJs: false,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
      },
      include: ["next-env.d.ts", "apps/**/*.ts", "apps/**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }, null, 2)}\n`,
    "next-env.d.ts": '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    [join("apps", appName, "project.json")]: `${JSON.stringify({
      name: appName,
      $schema: "../../node_modules/nx/schemas/project-schema.json",
      sourceRoot: `apps/${appName}`,
      projectType: "application",
      targets: {
        build: {
          executor: "@nx/next:build",
          outputs: ["{options.outputPath}"],
          options: {
            outputPath: `dist/apps/${appName}`,
          },
        },
        dev: {
          executor: "@nx/next:server",
          options: {
            buildTarget: `${appName}:build`,
            dev: true,
          },
        },
        start: {
          executor: "@nx/next:server",
          options: {
            buildTarget: `${appName}:build`,
            dev: false,
          },
        },
      },
    }, null, 2)}\n`,
    [join("apps", appName, "next.config.js")]:
      "const { composePlugins, withNx } = require('@nx/next');\n\nmodule.exports = composePlugins(withNx)({\n  nx: {\n    svgr: false,\n  },\n});\n",
    [join("apps", appName, "src", "app", "layout.tsx")]:
      "import './globals.css';\n\nexport const metadata = {\n  title: 'DevSpace App',\n  description: 'Generated by DevSpace',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n",
    [join("apps", appName, "src", "app", "page.tsx")]:
      "export default function Page() {\n  return (\n    <main className=\"shell\">\n      <section className=\"hero\">\n        <p className=\"eyebrow\">DevSpace</p>\n        <h1>Ready for a custom build.</h1>\n        <p className=\"lede\">This isolated Nx app was generated without touching the parent workspace graph.</p>\n      </section>\n    </main>\n  );\n}\n",
    [join("apps", appName, "src", "app", "globals.css")]:
      ":root {\n  color-scheme: light;\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;\n  background: #f6f7f9;\n  color: #171a1f;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n}\n\n.shell {\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 48px 20px;\n}\n\n.hero {\n  width: min(720px, 100%);\n}\n\n.eyebrow {\n  margin: 0 0 12px;\n  color: #476172;\n  font-size: 14px;\n  font-weight: 700;\n  text-transform: uppercase;\n}\n\nh1 {\n  margin: 0;\n  font-size: clamp(40px, 8vw, 76px);\n  line-height: 1;\n  letter-spacing: 0;\n}\n\n.lede {\n  margin: 20px 0 0;\n  max-width: 560px;\n  color: #4a5565;\n  font-size: 18px;\n  line-height: 1.6;\n}\n",
  };
}

async function createIsolatedApp(
  guard: PathGuard,
  ws: Workspace,
  input: CreateAppInput,
): Promise<CreateAppResult> {
  if (input.framework !== "next") {
    throw new CreateAppError("isolated mode currently supports framework=next");
  }
  const cwd = await guard.resolveForRead(ws.root, input.path ?? ".");
  const st = await stat(cwd).catch(() => null);
  if (!st?.isDirectory()) throw new CreateAppError(`App path is not a directory: ${input.path ?? "."}`);

  const packageManager = input.packageManager ?? await detectPackageManager(cwd);
  const parentPkg = await readPackageJson(cwd);
  const baseDirectory = input.directory ?? "devspace-apps";
  const parentDir = await ensureDirectoryInside(cwd, baseDirectory, guard, !input.dryRun);
  const workspaceRoot = resolve(parentDir, input.appName);
  if (!isInsideOrEqual(workspaceRoot, cwd) || !guard.isWithinAllowedRoots(parentDir)) {
    throw new CreateAppError("Generated workspace would escape the opened workspace");
  }
  if (await access(workspaceRoot).then(() => true).catch(() => false)) {
    throw new CreateAppError(`Refusing to overwrite existing app workspace: ${relative(cwd, workspaceRoot)}`);
  }

  const { command, args } = createIsolatedAppCommand(input);
  const files = nextWorkspaceFiles(input.appName, parentPkg, packageManager);
  const generatedFiles = Object.keys(files).sort();
  if (!input.dryRun) {
    await mkdir(workspaceRoot);
    for (const [filePath, content] of Object.entries(files)) {
      const target = resolve(workspaceRoot, filePath);
      if (!isInsideOrEqual(target, workspaceRoot)) {
        throw new CreateAppError(`Generated file escapes app workspace: ${filePath}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }

  return {
    appName: input.appName,
    framework: input.framework,
    mode: "isolated",
    cwd,
    workspaceRoot,
    generatedFiles,
    packageManager,
    command,
    args,
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    stdout: `${input.dryRun ? "Would create" : "Created"} isolated Nx workspace at ${relative(cwd, workspaceRoot)}\n${generatedFiles.join("\n")}`,
    stderr: "",
    durationMs: 0,
  };
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
  if ((input.mode ?? "isolated") === "isolated") {
    return createIsolatedApp(guard, ws, input);
  }
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
        mode: "existing",
        cwd,
        workspaceRoot: cwd,
        generatedFiles: [],
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
