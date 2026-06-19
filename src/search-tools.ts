/**
 * search-tools.ts — find_files (by glob) and search_files (by content).
 *
 * Design choice: we do NOT shell out to ripgrep. Traversal uses fast-glob with
 * `followSymbolicLinks:false` (so a symlink can never walk us out of the root),
 * and content matching happens in-process. This keeps the whole search path
 * auditable and removes an external-binary dependency, at the cost of raw speed
 * on very large trees — bounded by hard caps below.
 *
 * Safety properties:
 *   - cwd is pinned to the workspace root; patterns with `..` or absolute paths
 *     are rejected, and every candidate is re-validated through the PathGuard
 *     before it is opened.
 *   - dotfiles are skipped by default (avoids surfacing .env and friends to the
 *     model), plus a default denylist and the workspace's .gitignore.
 *   - literal substring search by default. Regex is OPT-IN and routed through
 *     the linear-time `re2` engine (no catastrophic backtracking). If re2 is not
 *     installed, regex search is REFUSED rather than run unbounded on the main
 *     event loop (an attacker-supplied pattern like (a+)+$ would otherwise
 *     freeze the whole single-process server). Match input is length-capped per
 *     line as a further bound.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { relative } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";

const DEFAULT_DENYLIST = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
];

const MAX_FILES_SCANNED = 20_000;
/** Per-line input cap for matching (defends against multi-MB newline-free lines). */
const MAX_MATCH_LINE = 2000;

// Optional linear-time regex engine. Loaded lazily; absence ⇒ regex refused.
let re2Ctor: any = null;
let re2Loaded = false;
async function loadRe2(): Promise<any> {
  if (re2Loaded) return re2Ctor;
  re2Loaded = true;
  try {
    const spec = "re2"; // non-literal specifier: keeps it an optional runtime dep
    const mod: any = await import(spec);
    re2Ctor = mod.default ?? mod;
  } catch {
    re2Ctor = null;
  }
  return re2Ctor;
}

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

function assertSafeGlob(glob: string): void {
  if (glob.startsWith("/") || glob.startsWith("\\")) {
    throw new SearchError("glob must be workspace-relative (no leading slash)");
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(glob)) {
    throw new SearchError("glob must not contain '..' segments");
  }
}

/** Build an `ignore` matcher from the workspace's root .gitignore, if present. */
async function loadGitignore(root: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  try {
    const content = await fsReadFile(`${root}/.gitignore`, "utf8");
    ig.add(content);
  } catch {
    // no .gitignore — fine
  }
  return ig;
}

async function candidateFiles(
  ws: Workspace,
  glob: string,
  opts: { includeDotfiles: boolean; respectGitignore: boolean; limit: number },
): Promise<{ files: string[]; truncated: boolean }> {
  assertSafeGlob(glob);
  const matches = await fg(glob, {
    cwd: ws.root,
    onlyFiles: true,
    followSymbolicLinks: false, // critical: symlinks never escape the root
    dot: opts.includeDotfiles,
    ignore: DEFAULT_DENYLIST,
    suppressErrors: true,
    unique: true,
    braceExpansion: true,
    globstar: true,
    caseSensitiveMatch: process.platform !== "win32",
  });

  let files = matches;
  if (opts.respectGitignore) {
    const ig = await loadGitignore(ws.root);
    files = ig.filter(files);
  }

  if (files.length > MAX_FILES_SCANNED) {
    files = files.slice(0, MAX_FILES_SCANNED);
  }
  const truncated = files.length > opts.limit;
  return { files: files.slice(0, opts.limit), truncated };
}

export interface FindFilesResult {
  files: string[];
  truncated: boolean;
}

export async function findFiles(
  _guard: PathGuard,
  ws: Workspace,
  glob: string,
  opts: { maxResults?: number; includeDotfiles?: boolean; respectGitignore?: boolean } = {},
): Promise<FindFilesResult> {
  const limit = opts.maxResults ?? 500;
  const { files, truncated } = await candidateFiles(ws, glob || "**/*", {
    includeDotfiles: opts.includeDotfiles ?? false,
    respectGitignore: opts.respectGitignore ?? true,
    limit,
  });
  return { files: files.sort(), truncated };
}

export interface SearchMatch {
  file: string;
  lineNumber: number;
  line: string;
}

export interface SearchFilesOptions {
  query: string;
  glob?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults: number;
  maxFileBytes: number;
  includeDotfiles?: boolean;
  respectGitignore?: boolean;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface SearchFilesResult {
  matches: SearchMatch[];
  filesScanned: number;
  truncated: boolean;
}

export async function searchFiles(
  guard: PathGuard,
  ws: Workspace,
  opts: SearchFilesOptions,
): Promise<SearchFilesResult> {
  if (!opts.query) throw new SearchError("query is required");

  // Build a per-line matcher. Regex goes through re2 (linear time) or is
  // refused; literal substring is always safe.
  let matcher: (line: string) => boolean;
  if (opts.isRegex) {
    const RE2 = await loadRe2();
    if (!RE2) {
      throw new SearchError(
        "Regex search requires the optional 're2' engine (run: npm install re2). " +
          "Use literal search (isRegex=false) — unbounded backtracking regex is refused to prevent event-loop DoS.",
      );
    }
    let re: { test(s: string): boolean };
    try {
      re = new RE2(opts.query, opts.caseSensitive ? "" : "i");
    } catch (e) {
      throw new SearchError(`Invalid regex: ${(e as Error).message}`);
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = opts.caseSensitive ? opts.query : opts.query.toLowerCase();
    matcher = (line) => (opts.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const { files, truncated: listTruncated } = await candidateFiles(
    ws,
    opts.glob || "**/*",
    {
      includeDotfiles: opts.includeDotfiles ?? false,
      respectGitignore: opts.respectGitignore ?? true,
      limit: MAX_FILES_SCANNED,
    },
  );

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let truncated = listTruncated;

  for (const relPath of files) {
    if (matches.length >= opts.maxResults) {
      truncated = true;
      break;
    }
    // Re-validate every candidate path before opening it.
    let real: string;
    try {
      real = await guard.resolveForRead(ws.root, relPath);
    } catch {
      continue; // skip anything that no longer resolves inside the sandbox
    }

    let buf: Buffer;
    try {
      buf = await fsReadFile(real);
    } catch {
      continue;
    }
    if (buf.length > opts.maxFileBytes || looksBinary(buf)) continue;
    filesScanned++;

    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const probe = line.length > MAX_MATCH_LINE ? line.slice(0, MAX_MATCH_LINE) : line;
      if (matcher(probe)) {
        matches.push({
          file: relative(ws.root, real) || relPath,
          lineNumber: i + 1,
          line: line.length > 400 ? line.slice(0, 400) + "…" : line,
        });
        if (matches.length >= opts.maxResults) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { matches, filesScanned, truncated };
}
