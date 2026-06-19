/**
 * workspaces.ts — the workspace registry.
 *
 * Tools never accept arbitrary absolute host paths directly. The model must
 * first `open_workspace(path)` and get back an opaque `workspaceId`; every
 * later read/write/search/run call carries that id. This:
 *   - forces every file operation to be scoped to a directory the operator
 *     pre-approved (an allowed root, or a folder beneath one),
 *   - gives us a single, auditable point where a path becomes a sandbox,
 *   - matches the DevSpace "open once, reuse the id" workflow.
 *
 * The registry is created PER MCP SESSION (see mcp-server.ts) so two clients
 * cannot see each other's open workspaces.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { PathGuard } from "./path-guard.js";

export interface Workspace {
  id: string;
  /** Canonical realpath of the workspace root — inside an allowed root. */
  root: string;
  openedAt: number;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const MAX_WORKSPACES = 64;

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(
    private readonly guard: PathGuard,
    /** The allowed roots, for resolving relative open() inputs + error text. */
    private readonly allowedRoots: readonly string[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The directories a client is allowed to open. Surfaced to the model. */
  roots(): readonly string[] {
    return this.allowedRoots;
  }

  /**
   * Open a workspace. `input` may be an absolute path, or a path relative to
   * one of the allowed roots. The resolved directory must be an allowed root
   * or live beneath one.
   */
  async open(input: string): Promise<Workspace> {
    if (!input || input.trim() === "") {
      throw new WorkspaceError(
        `A path is required. Allowed roots: ${this.allowedRoots.join(", ")}`,
      );
    }
    const trimmed = input.trim();

    const candidates: string[] = isAbsolute(trimmed)
      ? [trimmed]
      : this.allowedRoots.map((r) => resolve(r, trimmed));

    let lastErr = "";
    for (const candidate of candidates) {
      let real: string;
      try {
        real = await realpath(candidate);
      } catch {
        lastErr = `does not exist: ${candidate}`;
        continue;
      }
      if (!this.guard.isWithinAllowedRoots(real)) {
        lastErr = `outside allowed roots: ${candidate}`;
        continue;
      }
      let isDir = false;
      try {
        isDir = (await stat(real)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        lastErr = `not a directory: ${candidate}`;
        continue;
      }

      // Reuse an existing handle for the same root (idempotent open).
      for (const ws of this.workspaces.values()) {
        if (ws.root === real) return ws;
      }

      if (this.workspaces.size >= MAX_WORKSPACES) {
        throw new WorkspaceError(
          `Too many open workspaces (max ${MAX_WORKSPACES}).`,
        );
      }

      const ws: Workspace = { id: randomUUID(), root: real, openedAt: this.now() };
      this.workspaces.set(ws.id, ws);
      return ws;
    }

    throw new WorkspaceError(
      `Cannot open "${input}" (${lastErr}). ` +
        `Allowed roots: ${this.allowedRoots.join(", ")}`,
    );
  }

  get(id: string): Workspace {
    const ws = this.workspaces.get(id);
    if (!ws) {
      throw new WorkspaceError(
        "Unknown workspaceId. Call open_workspace first and reuse the id it returns.",
      );
    }
    return ws;
  }

  list(): Workspace[] {
    return [...this.workspaces.values()];
  }
}
