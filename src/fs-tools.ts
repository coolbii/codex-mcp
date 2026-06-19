/**
 * fs-tools.ts — read-only filesystem primitives: read_file, list_directory.
 *
 * Pure functions (no MCP/SDK coupling) so they are trivially unit-testable.
 * The MCP layer in mcp-server.ts wires these to tool schemas.
 *
 * Defense in depth:
 *   - the PathGuard resolves + contains the path (symlink-aware realpath),
 *   - then we open with O_NOFOLLOW and fstat the *fd* (not a re-lookup), so a
 *     symlink swapped in after the guard check still cannot be followed.
 */
import { open, opendir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { basename, relative } from "node:path";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";

export interface ReadFileOptions {
  /** 1-based start line (inclusive). */
  offset?: number;
  /** Max number of lines to return. */
  limit?: number;
  /** Hard byte ceiling (defends against huge files). */
  maxBytes: number;
}

export interface ReadFileResult {
  path: string;
  bytes: number;
  truncated: boolean;
  /** Set when we declined to return content (binary / too large). */
  notice?: string;
  text: string;
  totalLines?: number;
  returnedLines?: number;
}

/** Heuristic binary sniff: a NUL byte in the first chunk ⇒ treat as binary. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function readFile(
  guard: PathGuard,
  ws: Workspace,
  inputPath: string,
  opts: ReadFileOptions,
): Promise<ReadFileResult> {
  const real = await guard.resolveForRead(ws.root, inputPath);
  const rel = relative(ws.root, real) || basename(real);

  // O_NOFOLLOW: if the final component is a symlink, open() fails (ELOOP).
  const fh = await open(real, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error("Not a regular file");
    }
    const wanted = Math.min(st.size, opts.maxBytes);
    const buf = Buffer.alloc(wanted);
    const { bytesRead } = await fh.read(buf, 0, wanted, 0);
    const slice = buf.subarray(0, bytesRead);
    const truncatedByBytes = st.size > opts.maxBytes;

    if (looksBinary(slice)) {
      return {
        path: rel,
        bytes: st.size,
        truncated: truncatedByBytes,
        notice: "Binary file — content omitted.",
        text: "",
      };
    }

    let text = slice.toString("utf8");
    let totalLines: number | undefined;
    let returnedLines: number | undefined;

    if (opts.offset !== undefined || opts.limit !== undefined) {
      const lines = text.split("\n");
      totalLines = lines.length;
      const start = Math.max(0, (opts.offset ?? 1) - 1);
      const end = opts.limit !== undefined ? start + opts.limit : lines.length;
      const chosen = lines.slice(start, end);
      returnedLines = chosen.length;
      text = chosen.join("\n");
    }

    return {
      path: rel,
      bytes: st.size,
      truncated: truncatedByBytes,
      text,
      ...(totalLines !== undefined ? { totalLines } : {}),
      ...(returnedLines !== undefined ? { returnedLines } : {}),
    };
  } finally {
    await fh.close();
  }
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

export async function listDirectory(
  guard: PathGuard,
  ws: Workspace,
  inputPath: string,
  maxEntries = 1000,
): Promise<ListDirectoryResult> {
  const real = await guard.resolveForRead(ws.root, inputPath || ".");
  const rel = relative(ws.root, real) || ".";

  const entries: DirEntry[] = [];
  let truncated = false;
  // opendir streams — bounded memory even for huge directories.
  const dir = await opendir(real);
  try {
    for await (const dirent of dir) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      let type: DirEntry["type"] = "other";
      if (dirent.isSymbolicLink()) type = "symlink";
      else if (dirent.isDirectory()) type = "directory";
      else if (dirent.isFile()) type = "file";
      entries.push({ name: dirent.name, type });
    }
  } finally {
    // opendir's async iterator closes itself on completion/break, but be safe.
    await dir.close().catch(() => {});
  }

  entries.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    // directories first, then files, then the rest
    const rank = (t: DirEntry["type"]) =>
      t === "directory" ? 0 : t === "file" ? 1 : 2;
    return rank(a.type) - rank(b.type);
  });

  return { path: rel, entries, truncated };
}
