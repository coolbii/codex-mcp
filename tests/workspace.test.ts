import { it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { makeFixture, type Fixture } from "./helpers.js";
import { WorkspaceError } from "../src/workspaces.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

it("opens an allowed root", async () => {
  fx = await makeFixture();
  const ws = await fx.registry.open(fx.root);
  expect(ws.root).toBe(fx.root);
});

it("opens a subdirectory of a root", async () => {
  fx = await makeFixture();
  await mkdir(join(fx.root, "sub"));
  const ws = await fx.registry.open(join(fx.root, "sub"));
  expect(ws.root).toBe(join(fx.root, "sub"));
});

it("rejects a path outside the allowed roots", async () => {
  fx = await makeFixture();
  await expect(fx.registry.open(fx.base)).rejects.toBeInstanceOf(WorkspaceError);
});

it("rejects a nonexistent path", async () => {
  fx = await makeFixture();
  await expect(fx.registry.open(join(fx.root, "nope"))).rejects.toBeInstanceOf(WorkspaceError);
});

it("open is idempotent for the same root", async () => {
  fx = await makeFixture();
  const a = await fx.registry.open(fx.root);
  const b = await fx.registry.open(fx.root);
  expect(a.id).toBe(b.id);
});

it("get throws for an unknown id", async () => {
  fx = await makeFixture();
  expect(() => fx.registry.get("bogus")).toThrow(WorkspaceError);
});
