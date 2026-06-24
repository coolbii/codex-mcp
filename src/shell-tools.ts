/**
 * shell-tools.ts — run_command, the single most dangerous capability.
 *
 * It is DISABLED by default (config.enableShell === false ⇒ the tool is never
 * registered). When enabled:
 *
 *   - We spawn with `shell: false` and an explicit argv array. There is NO
 *     shell, so `;` `|` `&&` `$()` backticks redirects globs are passed as
 *     literal characters to the program, not interpreted. Command chaining is
 *     structurally impossible.
 *   - `restricted` mode (default): only an allowlisted binary + subcommand may
 *     run, with a denylist of known code-execution flags.
 *   - `unrestricted` mode (gated behind ALLOW_UNRESTRICTED_SHELL, local-only):
 *     any binary, still argv-only + scrubbed env + caps. No pipes/redirection.
 *   - Env is scrubbed to a tiny allowlist, so secrets (owner token, AWS_*, …)
 *     are never visible to the child.
 *   - cwd is pinned to the workspace root; output is byte-capped; a timeout
 *     SIGKILLs the process tree.
 *
 * HONEST LIMITATION (per the security spec): an allowlist of binaries is
 * workflow control, not a sandbox. `git`'s own flags can be coaxed into
 * running code; that is why interpreters (npm/node/python/make) are NOT
 * allowlisted and why the only *strong* boundary is a container/sandbox
 * wrapper (documented in docs/security.md as the next step for shared hosts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { devNull } from "node:os";
import type { AppConfig } from "./config.js";
import type { Workspace } from "./workspaces.js";

/**
 * Server-controlled `-c` overrides prepended to every `git` invocation. These
 * take precedence over the repo's own .git/config, neutralising the keys that
 * turn an otherwise read-only git subcommand into arbitrary code execution
 * (core.fsmonitor, external diff/textconv, hooks, pager, ssh/askpass). The model
 * cannot reach this surface — its own `-c` is denied (see RESTRICTED_ALLOW) and
 * writes into `.git/**` are denied at the PathGuard.
 */
export const GIT_HARDENING_ARGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.fsmonitorHookVersion=0",
  "-c", "core.hooksPath=" + devNull,
  "-c", "core.pager=cat",
  "-c", "core.sshCommand=",
  "-c", "core.askpass=",
  "-c", "protocol.ext.allow=never",
  "-c", "uploadpack.packObjectsHook=",
];

// Subcommands that route through git's diff machinery. We inject --no-ext-diff
// and --no-textconv RIGHT AFTER the subcommand to neutralise external-diff and
// textconv-driver code execution. (Note: setting `diff.external=` empty does NOT
// disable it — git tries to exec the empty string and `git diff` dies; these
// per-invocation flags are the correct neutraliser.)
export const GIT_DIFF_SUBCOMMANDS = new Set(["diff", "log", "show"]);
export const GIT_DIFF_NEUTRALISERS = ["--no-ext-diff", "--no-textconv"];

/** Kill the whole process group so detached grandchildren cannot survive. */
function killTree(child: ChildProcess): void {
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    /* group already gone or never started — fall through */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

export class ShellError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellError";
  }
}

interface CommandPolicy {
  /** Allowed first positional token (the subcommand). */
  subcommands: Set<string>;
  /** Args matching this are rejected outright (code-exec / file-write flags). */
  deniedArg: RegExp;
}

/**
 * Conservative read-only allowlist. Deliberately excludes anything that can
 * interpret/execute repo-controlled input (npm, node, make, python, sh) and
 * excludes git subcommands that mutate or fetch.
 */
const RESTRICTED_ALLOW: Record<string, CommandPolicy> = {
  git: {
    subcommands: new Set([
      "status",
      "diff",
      "log",
      "show",
      "rev-parse",
      "branch",
      "describe",
      "shortlog",
      "tag",
      "ls-files",
      "blame",
    ]),
    // -c (config injection), --output/-O (arbitrary file write),
    // --ext-diff / --exec / --upload-pack (external command execution).
    deniedArg: /^(-c|--exec\b|--upload-pack|--output\b|-O|--ext-diff)/,
  },
};

const SAFE_BIN = /^[A-Za-z0-9._-]+$/; // no path separators — PATH lookup only

export interface RunCommandResult {
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

function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    // Neutralise git's auto-loaded system/global config + system attributes.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
  };
  for (const k of allow) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function validateRestricted(command: string, args: string[]): void {
  const policy = RESTRICTED_ALLOW[command];
  if (!policy) {
    throw new ShellError(
      `Command not allowed in restricted mode: ${command}. ` +
        `Allowed: ${Object.keys(RESTRICTED_ALLOW).join(", ")}.`,
    );
  }
  const sub = args[0];
  if (!sub || !policy.subcommands.has(sub)) {
    throw new ShellError(
      `Subcommand not allowed: ${command} ${sub ?? "(none)"}. ` +
        `Allowed: ${[...policy.subcommands].join(", ")}.`,
    );
  }
  for (const a of args) {
    if (policy.deniedArg.test(a)) {
      throw new ShellError(`Argument not allowed: ${a}`);
    }
  }
}

export async function runCommand(
  config: AppConfig,
  ws: Workspace,
  command: string,
  args: string[] = [],
): Promise<RunCommandResult> {
  if (!config.enableShell) {
    throw new ShellError("Shell is disabled (set ENABLE_SHELL=1 to enable).");
  }
  if (!SAFE_BIN.test(command)) {
    throw new ShellError(
      `Invalid command "${command}" — provide a bare binary name (no path separators).`,
    );
  }
  for (const a of args) {
    if (a.includes("\0")) throw new ShellError("Argument contains a NUL byte.");
  }

  if (config.shellMode === "restricted") {
    validateRestricted(command, args);
  }

  // git reads .git/config automatically; prepend trusted overrides that beat it,
  // and neutralise diff/textconv drivers per-subcommand.
  let execArgs: string[];
  if (command === "git") {
    const [sub, ...rest] = args;
    if (sub && GIT_DIFF_SUBCOMMANDS.has(sub)) {
      execArgs = [...GIT_HARDENING_ARGS, sub, ...GIT_DIFF_NEUTRALISERS, ...rest];
    } else {
      execArgs = [...GIT_HARDENING_ARGS, ...args];
    }
  } else {
    execArgs = args;
  }

  const startedAt = Date.now();
  return await new Promise<RunCommandResult>((resolveResult, reject) => {
    const child = spawn(command, execArgs, {
      cwd: ws.root,
      shell: false, // NEVER true — this is what makes injection structurally impossible
      windowsHide: true,
      detached: process.platform !== "win32", // own process group ⇒ we can kill the whole tree
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
      reject(new ShellError(`Failed to start "${command}": ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
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
