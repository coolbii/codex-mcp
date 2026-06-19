/**
 * edit-tools.ts — write_file, edit_file, show_diff.
 *
 * Every mutation returns a unified diff so the operator (and the client UI)
 * can see exactly what changed. Writes are atomic and symlink-safe:
 *   - new file: O_CREAT|O_EXCL|O_NOFOLLOW — fails if anything (incl. a planted
 *     symlink) already occupies the path.
 *   - overwrite: write a sibling temp file, fsync, rename over the target.
 *     rename replaces the directory entry itself, so it never writes *through*
 *     a symlink; the PathGuard has already rejected escaping symlinks.
 */
import { open, rename, readFile as fsReadFile, unlink, stat } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { dirname, basename, relative, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";

const MAX_WRITE_BYTES = 10_000_000;

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export interface Replacement {
  oldText: string;
  newText: string;
}

/**
 * Pure exact-string replacement. Each `oldText` must occur exactly once unless
 * `replaceAll` is set. Edits apply sequentially against the evolving result.
 */
export function applyExactEdits(
  original: string,
  edits: Replacement[],
  replaceAll = false,
): string {
  if (edits.length === 0) throw new EditError("No edits provided");
  let result = original;
  for (const [i, edit] of edits.entries()) {
    if (edit.oldText === "") {
      throw new EditError(`edit[${i}].oldText is empty`);
    }
    const first = result.indexOf(edit.oldText);
    if (first === -1) {
      throw new EditError(`edit[${i}].oldText not found in file`);
    }
    if (!replaceAll) {
      const second = result.indexOf(edit.oldText, first + edit.oldText.length);
      if (second !== -1) {
        throw new EditError(
          `edit[${i}].oldText is not unique (matches more than once) — add more context or set replaceAll`,
        );
      }
      result = result.slice(0, first) + edit.newText + result.slice(first + edit.oldText.length);
    } else {
      result = result.split(edit.oldText).join(edit.newText);
    }
  }
  return result;
}

function makeDiff(rel: string, oldStr: string, newStr: string): string {
  return createTwoFilesPatch(
    `a/${rel}`,
    `b/${rel}`,
    oldStr,
    newStr,
    undefined,
    undefined,
    { context: 3 },
  );
}

/** Atomic, symlink-safe write of an existing-or-new target. */
async function writeAtomic(finalPath: string, content: string, createOnly: boolean): Promise<void> {
  if (createOnly) {
    const fh = await open(
      finalPath,
      FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW,
      0o600,
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "EEXIST") throw new EditError("File already exists (use overwrite)");
      throw e;
    });
    try {
      await fh.writeFile(content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return;
  }

  const dir = dirname(finalPath);
  const tmp = join(dir, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, finalPath);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export interface WriteResult {
  path: string;
  created: boolean;
  bytes: number;
  diff: string;
}

export async function writeFile(
  guard: PathGuard,
  ws: Workspace,
  inputPath: string,
  content: string,
  opts: { createOnly?: boolean } = {},
): Promise<WriteResult> {
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new EditError(`Content exceeds ${MAX_WRITE_BYTES} bytes`);
  }
  const target = await guard.resolveForWrite(ws.root, inputPath);
  const rel = relative(ws.root, target) || basename(target);

  let oldStr = "";
  let existed = false;
  const existing = await stat(target).catch(() => undefined);
  if (existing?.isFile()) {
    existed = true;
    oldStr = await fsReadFile(target, "utf8").catch(() => "");
  }
  if (opts.createOnly && existed) {
    throw new EditError("File already exists (createOnly=true)");
  }

  await writeAtomic(target, content, Boolean(opts.createOnly) && !existed);

  return {
    path: rel,
    created: !existed,
    bytes: Buffer.byteLength(content, "utf8"),
    diff: makeDiff(rel, oldStr, content),
  };
}

export interface EditResult {
  path: string;
  bytes: number;
  diff: string;
}

export async function editFile(
  guard: PathGuard,
  ws: Workspace,
  inputPath: string,
  edits: Replacement[],
  replaceAll = false,
): Promise<EditResult> {
  // Must exist + be readable inside the sandbox.
  const real = await guard.resolveForRead(ws.root, inputPath);
  const rel = relative(ws.root, real) || basename(inputPath);
  const oldStr = await fsReadFile(real, "utf8");
  const newStr = applyExactEdits(oldStr, edits, replaceAll);

  if (newStr === oldStr) {
    throw new EditError("Edits produced no change");
  }
  if (Buffer.byteLength(newStr, "utf8") > MAX_WRITE_BYTES) {
    throw new EditError(`Result exceeds ${MAX_WRITE_BYTES} bytes`);
  }

  // Resolve a write target (re-checks containment / symlink) then overwrite.
  const target = await guard.resolveForWrite(ws.root, inputPath);
  await writeAtomic(target, newStr, false);

  return { path: rel, bytes: Buffer.byteLength(newStr, "utf8"), diff: makeDiff(rel, oldStr, newStr) };
}

export interface ShowDiffResult {
  path: string;
  exists: boolean;
  diff: string;
}

/** Dry run: compute the diff a write would produce, WITHOUT touching disk. */
export async function showDiff(
  guard: PathGuard,
  ws: Workspace,
  inputPath: string,
  newContent: string,
): Promise<ShowDiffResult> {
  let oldStr = "";
  let exists = false;
  try {
    const real = await guard.resolveForRead(ws.root, inputPath);
    oldStr = await fsReadFile(real, "utf8").catch(() => "");
    exists = true;
  } catch {
    exists = false; // new file
  }
  // Validate the target is writable/contained even on a dry run.
  await guard.resolveForWrite(ws.root, inputPath);
  const rel = relative(ws.root, join(ws.root, inputPath)) || basename(inputPath);
  return { path: rel, exists, diff: makeDiff(rel, oldStr, newContent) };
}
