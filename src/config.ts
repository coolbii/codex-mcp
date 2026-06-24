/**
 * config.ts — fail-closed configuration.
 *
 * Everything here is validated at startup. If anything is unsafe or
 * ambiguous we THROW rather than guess. The security posture is:
 *   - allowed roots must be narrow (never $HOME, /, or a secrets dir)
 *   - HTTP transport requires auth unless explicitly opted out on loopback
 *   - DNS-rebinding protection (Host/Origin allowlist) on by default
 *
 * No secret value (owner token) is ever logged from here.
 */
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { realpathSync, statSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isInsideOrEqual } from "./path-util.js";

/**
 * A bare repo / git-dir has config + hooks + info/attributes at its top level
 * (no `.git/` prefix), so the `.git`-segment write denial would not cover them
 * and an allowlisted git command run there could be coaxed into executing code.
 * Refuse such a directory as an allowed root.
 */
function looksLikeGitDir(dir: string): boolean {
  return (
    existsSync(join(dir, "HEAD")) &&
    existsSync(join(dir, "objects")) &&
    existsSync(join(dir, "refs"))
  );
}

export type ShellMode = "restricted" | "unrestricted";
export type TransportName = "http" | "stdio";

export interface AppConfig {
  /** Loopback by default. Bind address for the HTTP transport. */
  host: string;
  port: number;
  /** Public origin (no path) when fronted by a tunnel; null for pure-local. */
  publicBaseUrl: string | null;

  /** realpath-resolved, validated, de-duped. The hard filesystem boundary. */
  allowedRoots: string[];
  /** As the operator typed them — for human-readable errors only. */
  rawAllowedRoots: string[];

  /**
   * Where versioned static projects (create_project / sites) are written and
   * served from. realpath-resolved and guaranteed to be inside allowedRoots.
   * null ⇒ legacy behavior (a `devspace-sites/` folder under allowedRoots[0]).
   */
  projectsRoot: string | null;

  /** Readable-but-not-writable roots (inside allowedRoots). Writes under these
   *  are refused — e.g. a live trading bot's source exposed for read-only review. */
  readonlyRoots: string[];

  /** When true, /mcp requires a valid bearer token. */
  requireAuth: boolean;
  /** Bearer token. Generated + flagged if the operator did not supply one. */
  ownerToken: string;
  ownerTokenGenerated: boolean;

  /**
   * 'owner_token' (default): static bearer token for local clients (Claude
   * Desktop / Inspector / curl). 'oauth': embedded OAuth 2.1 AS so ChatGPT web
   * can connect (DCR + PKCE; OWNER_TOKEN doubles as the login password). The
   * owner token is still accepted as a bearer in oauth mode.
   */
  authMode: "owner_token" | "oauth";
  /** Persisted OAuth client + refresh-token store (oauth mode). 0600. */
  oauthStorePath: string;

  /** DNS-rebinding protection inputs for the HTTP transport. */
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];

  /** Shell is OFF unless explicitly enabled, and restricted unless forced. */
  enableShell: boolean;
  shellMode: ShellMode;
  logShellCommands: boolean;
  /** Package installation is a separate opt-in capability from shell. */
  enablePackageInstall: boolean;
  /** Nx app scaffolding runs project code, so it is opt-in too. */
  enableAppScaffold: boolean;

  /** Extra credential-file glob patterns (DENY_PATHS) beyond the built-ins.
   *  Denied paths are refused by read_file and hidden from find/search. */
  denyPaths: string[];
  /** Redact high-confidence secrets from returned file/search content. */
  secretScan: boolean;

  /** Resource caps. */
  maxReadBytes: number;
  maxSearchMatches: number;
  maxSearchFileBytes: number;
  shellTimeoutMs: number;
  shellMaxOutputBytes: number;
}

export interface LoadConfigOptions {
  /** Which transport is being started — gates HTTP-only requirements. */
  transport: TransportName;
  env?: NodeJS.ProcessEnv;
  /** Sink for non-fatal warnings (defaults to stderr). */
  warn?: (msg: string) => void;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// small parsing helpers
// ---------------------------------------------------------------------------

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`Expected a boolean, got "${value}"`);
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// allowed-roots validation — the most important config gate
// ---------------------------------------------------------------------------

function validateAllowedRoots(
  raw: string[],
  warn: (msg: string) => void,
): string[] {
  if (raw.length === 0) {
    throw new ConfigError(
      "ALLOWED_ROOTS is required (comma-separated absolute paths). " +
        "Use narrow project folders, never ~, /, or a secrets directory.",
    );
  }

  const home = realpathSafe(homedir());
  const fsRoot = resolve("/");
  // Directories that must never be inside (or equal to) an allowed root.
  const secretsDirs = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".npmrc",
  ].map((d) => resolve(home, d));
  // Directories we permit but warn about (often hold sensitive files).
  const cautionDirs = ["Downloads", "Documents", "Desktop"].map((d) =>
    resolve(home, d),
  );

  const resolved: string[] = [];
  for (const entry of raw) {
    const abs = resolve(expandHome(entry));

    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new ConfigError(
        `ALLOWED_ROOTS entry does not exist or is unreadable: ${entry}`,
      );
    }

    let isDir = false;
    try {
      isDir = statSync(real).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new ConfigError(`ALLOWED_ROOTS entry is not a directory: ${entry}`);
    }
    if (looksLikeGitDir(real)) {
      throw new ConfigError(
        `Refusing an allowed root that is a git directory / bare repo (its config & hooks can drive code execution): ${entry}`,
      );
    }

    if (real === fsRoot) {
      throw new ConfigError(`Refusing filesystem root as an allowed root: ${entry}`);
    }
    // Root must not contain (or equal) the whole home directory — that would
    // expose dotfiles, keychains, browser profiles, everything.
    if (isInsideOrEqual(home, real)) {
      throw new ConfigError(
        `Refusing an allowed root that contains your home directory: ${entry}. ` +
          "Point at a specific project folder instead.",
      );
    }
    for (const secret of secretsDirs) {
      if (isInsideOrEqual(secret, real) || isInsideOrEqual(real, secret)) {
        throw new ConfigError(
          `Refusing an allowed root that overlaps a secrets directory (${secret}): ${entry}`,
        );
      }
    }
    for (const caution of cautionDirs) {
      if (isInsideOrEqual(real, caution) || isInsideOrEqual(caution, real)) {
        warn(
          `ALLOWED_ROOTS includes a sensitive location (${caution}): ${entry}. ` +
            "Prefer a dedicated code workspace folder.",
        );
      }
    }

    resolved.push(real);
  }

  // De-dupe and drop roots nested inside another root (the outer one wins).
  const unique = [...new Set(resolved)].sort();
  const minimal: string[] = [];
  for (const r of unique) {
    if (minimal.some((m) => isInsideOrEqual(r, m))) continue;
    minimal.push(r);
  }
  return minimal;
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// ---------------------------------------------------------------------------
// public URL / host / origin
// ---------------------------------------------------------------------------

function parsePublicBaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`PUBLIC_BASE_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new ConfigError(
      `PUBLIC_BASE_URL must be https (or loopback for local testing): ${value}`,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new ConfigError(
      `PUBLIC_BASE_URL should be an origin without a path (got "${url.pathname}"). ` +
        "Clients append /mcp themselves.",
    );
  }
  return url.origin;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export function loadConfig(opts: LoadConfigOptions): AppConfig {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`[config][warn] ${m}\n`));
  const isHttp = opts.transport === "http";

  const rawAllowedRoots = csv(env.ALLOWED_ROOTS);
  // PROJECTS_ROOT (where versioned static projects live) is validated through
  // the SAME gate as allowed roots and is implicitly added to them, so the
  // path guard and per-folder git confinement both permit it.
  const rawProjectsRoot = (env.PROJECTS_ROOT ?? "").trim();
  // READONLY_ROOTS: readable-but-not-writable paths (e.g. a live bot's source).
  // Validated through the same gate and must resolve inside an allowed root.
  const rawReadonlyRoots = csv(env.READONLY_ROOTS);
  const allowedRoots = validateAllowedRoots(
    [...rawAllowedRoots, ...(rawProjectsRoot ? [rawProjectsRoot] : []), ...rawReadonlyRoots],
    warn,
  );
  let projectsRoot: string | null = null;
  if (rawProjectsRoot) {
    const realProjectsRoot = realpathSafe(resolve(expandHome(rawProjectsRoot)));
    if (!allowedRoots.some((r) => isInsideOrEqual(realProjectsRoot, r))) {
      throw new ConfigError(
        `PROJECTS_ROOT must resolve inside an allowed root: ${rawProjectsRoot}`,
      );
    }
    projectsRoot = realProjectsRoot;
  }
  const readonlyRoots = rawReadonlyRoots.map((r) => realpathSafe(resolve(expandHome(r))));
  for (const rr of readonlyRoots) {
    if (!allowedRoots.some((r) => isInsideOrEqual(rr, r))) {
      throw new ConfigError(`READONLY_ROOTS must resolve inside an allowed root: ${rr}`);
    }
  }

  const host = (env.HOST ?? "127.0.0.1").trim();
  const port = int(env.PORT, 7676, "PORT");
  const publicBaseUrl = parsePublicBaseUrl(env.PUBLIC_BASE_URL);

  // ---- auth ----
  // HTTP defaults to requiring auth. The only escape hatch is loopback +
  // no public URL + an explicit, scary opt-out flag.
  let requireAuth = isHttp;
  const insecureLocalOptOut = bool(env.ALLOW_INSECURE_LOCAL, false);
  if (isHttp && insecureLocalOptOut) {
    if (!isLoopbackHost(host)) {
      throw new ConfigError(
        "ALLOW_INSECURE_LOCAL=1 is only permitted when HOST is loopback (127.0.0.1).",
      );
    }
    if (publicBaseUrl) {
      throw new ConfigError(
        "ALLOW_INSECURE_LOCAL=1 cannot be combined with PUBLIC_BASE_URL (a tunnel).",
      );
    }
    requireAuth = false;
    warn(
      "AUTH DISABLED (ALLOW_INSECURE_LOCAL=1). Only safe on a single-user loopback machine with no tunnel.",
    );
  }

  let ownerToken = (env.OWNER_TOKEN ?? "").trim();
  let ownerTokenGenerated = false;
  if (requireAuth) {
    if (ownerToken && ownerToken.length < 32) {
      throw new ConfigError("OWNER_TOKEN must be at least 32 characters.");
    }
    if (!ownerToken) {
      ownerToken = randomBytes(32).toString("base64url");
      ownerTokenGenerated = true;
    }
  }

  // ---- auth mode: owner_token (default) vs embedded OAuth AS (for ChatGPT) ----
  const rawAuthMode = (env.AUTH_MODE ?? "owner_token").trim().toLowerCase();
  if (rawAuthMode !== "owner_token" && rawAuthMode !== "oauth") {
    throw new ConfigError(`AUTH_MODE must be "owner_token" or "oauth", got "${rawAuthMode}".`);
  }
  const authMode = rawAuthMode;
  if (authMode === "oauth" && isHttp) {
    if (!requireAuth) {
      throw new ConfigError(
        "AUTH_MODE=oauth cannot be combined with ALLOW_INSECURE_LOCAL — OAuth requires auth.",
      );
    }
    if (!publicBaseUrl) {
      warn(
        "AUTH_MODE=oauth without PUBLIC_BASE_URL — OAuth issuer/resource falls back to the loopback URL. " +
          "Fine for local Inspector testing, but ChatGPT needs PUBLIC_BASE_URL set to your https tunnel.",
      );
    }
    if (ownerTokenGenerated) {
      warn(
        "OAuth login password = the generated ephemeral OWNER_TOKEN (changes on restart). " +
          "Set OWNER_TOKEN to keep your login stable.",
      );
    }
  }
  const oauthStorePath =
    (env.OAUTH_STORE_PATH ?? "").trim() || join(process.cwd(), "data", "devspace-oauth.json");

  // ---- DNS-rebinding / Host / Origin ----
  const enableDnsRebindingProtection = bool(
    env.ENABLE_DNS_REBINDING_PROTECTION,
    true,
  );
  const hostCandidates = new Set<string>([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `${host}:${port}`,
  ]);
  const originCandidates = new Set<string>([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  if (publicBaseUrl) {
    const u = new URL(publicBaseUrl);
    hostCandidates.add(u.host);
    originCandidates.add(u.origin);
  }
  const allowedHosts = csv(env.ALLOWED_HOSTS);
  const allowedOrigins = csv(env.ALLOWED_ORIGINS);
  const finalHosts = allowedHosts.length ? allowedHosts : [...hostCandidates];
  const finalOrigins = allowedOrigins.length ? allowedOrigins : [...originCandidates];

  if (isHttp && !isLoopbackHost(host) && host !== "0.0.0.0") {
    warn(`HOST is ${host} (non-loopback). Ensure auth + a trusted network front this.`);
  }
  if (isHttp && host === "0.0.0.0") {
    warn(
      "HOST=0.0.0.0 binds all interfaces. Strongly prefer 127.0.0.1 behind a tunnel. " +
        "DNS-rebinding protection and auth are mandatory in this mode.",
    );
    if (!requireAuth) {
      throw new ConfigError("Refusing HOST=0.0.0.0 without auth.");
    }
  }

  // ---- shell ----
  const enableShell = bool(env.ENABLE_SHELL, false);
  let shellMode: ShellMode = "restricted";
  const rawShellMode = (env.SHELL_MODE ?? "restricted").trim().toLowerCase();
  if (rawShellMode === "unrestricted") {
    if (!bool(env.ALLOW_UNRESTRICTED_SHELL, false)) {
      throw new ConfigError(
        "SHELL_MODE=unrestricted requires ALLOW_UNRESTRICTED_SHELL=1 (gives the client your shell — local-only, never behind a tunnel).",
      );
    }
    if (publicBaseUrl) {
      throw new ConfigError("Refusing unrestricted shell while a PUBLIC_BASE_URL (tunnel) is set.");
    }
    shellMode = "unrestricted";
    warn("SHELL_MODE=unrestricted — the connected client can run arbitrary commands as your user.");
  } else if (rawShellMode !== "restricted") {
    throw new ConfigError(`SHELL_MODE must be "restricted" or "unrestricted", got "${rawShellMode}".`);
  }
  if (enableShell) {
    warn(
      `Shell tool ENABLED (mode=${shellMode}). Command execution is the most dangerous capability; ` +
        "it is treated as giving the client your local user account.",
    );
  }
  const enablePackageInstall = bool(env.ENABLE_PACKAGE_INSTALL, false);
  if (enablePackageInstall) {
    warn(
      "Package install tool ENABLED. Installs can fetch third-party code and mutate lockfiles; " +
        "install scripts are disabled by default by the tool.",
    );
  }
  const enableAppScaffold = bool(env.ENABLE_APP_SCAFFOLD, false);
  if (enableAppScaffold) {
    warn(
      "Nx app scaffold tool ENABLED. Nx generators execute project dependencies and can mutate the workspace.",
    );
  }

  const config: AppConfig = {
    host,
    port,
    publicBaseUrl,
    allowedRoots,
    rawAllowedRoots,
    projectsRoot,
    readonlyRoots,
    requireAuth,
    ownerToken,
    ownerTokenGenerated,
    authMode,
    oauthStorePath,
    enableDnsRebindingProtection,
    allowedHosts: finalHosts,
    allowedOrigins: finalOrigins,
    enableShell,
    shellMode,
    logShellCommands: bool(env.LOG_SHELL_COMMANDS, false),
    enablePackageInstall,
    enableAppScaffold,
    denyPaths: csv(env.DENY_PATHS),
    secretScan: bool(env.SECRET_SCAN, true),
    maxReadBytes: int(env.MAX_READ_BYTES, 2_000_000, "MAX_READ_BYTES"),
    maxSearchMatches: int(env.MAX_SEARCH_MATCHES, 500, "MAX_SEARCH_MATCHES"),
    maxSearchFileBytes: int(env.MAX_SEARCH_FILE_BYTES, 5_000_000, "MAX_SEARCH_FILE_BYTES"),
    shellTimeoutMs: int(env.SHELL_TIMEOUT_MS, 30_000, "SHELL_TIMEOUT_MS"),
    shellMaxOutputBytes: int(env.SHELL_MAX_OUTPUT_BYTES, 200_000, "SHELL_MAX_OUTPUT_BYTES"),
  };

  return config;
}

/** Internal helpers exported for unit tests. */
export const __test = { isInsideOrEqual, expandHome, validateAllowedRoots, parsePublicBaseUrl };
