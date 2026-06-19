import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathGuard } from "../src/path-guard.js";
import { WorkspaceRegistry, type Workspace } from "../src/workspaces.js";

export interface Fixture {
  /** realpath'd temp base (the workspace root lives beneath it). */
  base: string;
  /** the allowed root == workspace root. */
  root: string;
  guard: PathGuard;
  ws: Workspace;
  registry: WorkspaceRegistry;
  cleanup: () => Promise<void>;
}

/** Create an isolated temp workspace with a PathGuard scoped to it. */
export async function makeFixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "devspace-test-")));
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  const guard = new PathGuard([root]);
  const registry = new WorkspaceRegistry(guard, [root]);
  const ws: Workspace = { id: "test-ws", root, openedAt: 0 };
  return {
    base,
    root,
    guard,
    ws,
    registry,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export async function write(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}
