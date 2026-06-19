/**
 * path-guard.ts — the hard filesystem boundary.
 *
 * Every file path that comes from the model passes through here. The rules:
 *
 *   - A path is resolved relative to a *base directory* (the open workspace
 *     root), never relative to process.cwd().
 *   - For reads, the target must EXIST and its realpath (symlinks resolved)
 *     must sit inside both the workspace root and one of the allowed roots.
 *   - For writes, the *parent* directory's realpath must sit inside the
 *     workspace; if the final component already exists as a symlink, its
 *     realpath must too (so you cannot overwrite-through a symlink that
 *     escapes the sandbox).
 *
 * realpath is what defends against symlink escape: relative()/resolve()
 * normalise "../" but do NOT follow a symlink that points outside the root.
 *
 * Residual risk (documented, not hidden): TOCTOU. Between the realpath check
 * and the actual open()/write(), an attacker who can create symlinks inside
 * the workspace at exactly the right moment could swap a component. In a
 * single-user, single-tenant box this is not a meaningful threat. If you ever
 * run this multi-tenant, move to *at()-family syscalls (openat/O_NOFOLLOW)
 * via a native addon, or run each workspace in its own container/namespace.
 */
import { resolve, dirname, relative, sep } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { isInsideOrEqual, CASE_INSENSITIVE_FS } from "./path-util.js";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export { isInsideOrEqual };

/**
 * Reject writes to git's own config surfaces. git reads .git/config and
 * .gitattributes automatically, and several keys (core.fsmonitor, external
 * diff/textconv drivers, hooks) execute arbitrary commands when an otherwise
 * "read-only" git subcommand runs. The model must never be able to plant those,
 * so writing anywhere under a `.git` dir — or to .gitattributes/.gitmodules — is
 * denied at the boundary (independent of whether the shell is even enabled).
 */
function assertNotGitConfigWrite(baseDir: string, target: string): void {
  const rel = relative(baseDir, target);
  // Fold case on case-insensitive volumes so `.GIT/config` (same dir as
  // `.git/config` on macOS/Windows) cannot slip past this check.
  const fold = (s: string) => (CASE_INSENSITIVE_FS ? s.toLowerCase() : s);
  const segments = rel.split(sep).map(fold);
  if (segments.includes(".git")) {
    throw new AccessDeniedError("Refusing to write inside a .git directory");
  }
  const leaf = segments[segments.length - 1];
  if (leaf === ".gitattributes" || leaf === ".gitmodules") {
    throw new AccessDeniedError(`Refusing to write ${leaf} (git config-driven execution risk)`);
  }
}

export class PathGuard {
  /** Allowed roots, already realpath-resolved by config. */
  private readonly roots: readonly string[];

  constructor(realAllowedRoots: readonly string[]) {
    if (realAllowedRoots.length === 0) {
      throw new Error("PathGuard requires at least one allowed root");
    }
    this.roots = realAllowedRoots;
  }

  /** Is this real (symlink-resolved) path inside any configured allowed root? */
  isWithinAllowedRoots(realPath: string): boolean {
    return this.roots.some((root) => isInsideOrEqual(realPath, root));
  }

  private assertWithinRoots(realPath: string): void {
    if (!this.isWithinAllowedRoots(realPath)) {
      throw new AccessDeniedError(`Path is outside the allowed roots: ${realPath}`);
    }
  }

  /**
   * Resolve a workspace-relative (or absolute) path for READING.
   * The target must exist. Returns the canonical realpath.
   *
   * @param baseDir  the workspace root — itself already a realpath inside roots
   * @param inputPath path from the model (relative to baseDir, or absolute)
   */
  async resolveForRead(baseDir: string, inputPath: string): Promise<string> {
    const candidate = resolve(baseDir, inputPath);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new AccessDeniedError(`No such file: ${inputPath}`);
      }
      throw new AccessDeniedError(`Cannot resolve path: ${inputPath}`);
    }
    // Must be inside this workspace, and inside an allowed root.
    if (!isInsideOrEqual(real, baseDir)) {
      throw new AccessDeniedError(`Path escapes the workspace: ${inputPath}`);
    }
    this.assertWithinRoots(real);
    return real;
  }

  /**
   * Resolve a path for WRITING (file may or may not exist yet).
   * Returns the absolute target path (NOT realpath — it may not exist).
   * Guarantees the parent dir is real and inside the workspace, and that we
   * are not writing through an escaping symlink.
   */
  async resolveForWrite(baseDir: string, inputPath: string): Promise<string> {
    const absolute = resolve(baseDir, inputPath);

    // Parent directory must already exist and be contained.
    const parent = dirname(absolute);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      throw new AccessDeniedError(
        `Parent directory does not exist or is unreadable: ${dirname(inputPath)}`,
      );
    }
    if (!isInsideOrEqual(realParent, baseDir)) {
      throw new AccessDeniedError(`Write target escapes the workspace: ${inputPath}`);
    }
    this.assertWithinRoots(realParent);

    // If the target itself already exists and is a symlink, its destination
    // must also be contained — otherwise an attacker-planted symlink would let
    // a write land outside the sandbox.
    const existing = await lstat(absolute).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = await realpath(absolute);
      } catch {
        throw new AccessDeniedError(`Refusing to write through a broken symlink: ${inputPath}`);
      }
      if (!isInsideOrEqual(realTarget, baseDir)) {
        throw new AccessDeniedError(`Refusing to write through a symlink that escapes the workspace: ${inputPath}`);
      }
      this.assertWithinRoots(realTarget);
    } else if (existing && !existing.isFile()) {
      throw new AccessDeniedError(`Refusing to overwrite a non-regular file: ${inputPath}`);
    }

    // Rebuild the absolute target on top of the *real* parent so the returned
    // path has no unresolved symlink components above the leaf.
    const leaf = absolute.slice(parent.length).replace(/^[/\\]/, "");
    const target = resolve(realParent, leaf);
    assertNotGitConfigWrite(baseDir, target);
    return target;
  }
}
