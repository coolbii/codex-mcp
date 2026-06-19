import { it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { makeFixture, type Fixture } from "./helpers.js";
import { readFile, listDirectory } from "../src/fs-tools.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

it("reads a text file", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.txt"), "line1\nline2\nline3\n");
  const r = await readFile(fx.guard, fx.ws, "a.txt", { maxBytes: 1000 });
  expect(r.text).toContain("line1");
});

it("honours offset/limit", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.txt"), "l1\nl2\nl3\nl4\n");
  const r = await readFile(fx.guard, fx.ws, "a.txt", { maxBytes: 1000, offset: 2, limit: 2 });
  expect(r.text).toBe("l2\nl3");
});

it("detects binary content and omits it", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "b.bin"), Buffer.from([1, 2, 0, 3, 4]));
  const r = await readFile(fx.guard, fx.ws, "b.bin", { maxBytes: 1000 });
  expect(r.notice).toBeDefined();
  expect(r.text).toBe("");
});

it("caps bytes for large files", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "big.txt"), "x".repeat(5000));
  const r = await readFile(fx.guard, fx.ws, "big.txt", { maxBytes: 100 });
  expect(r.truncated).toBe(true);
});

it("lists directory entries (dirs first)", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.txt"), "a");
  await mkdir(join(fx.root, "d"));
  const r = await listDirectory(fx.guard, fx.ws, ".");
  const names = r.entries.map((e) => e.name);
  expect(names).toContain("a.txt");
  expect(names).toContain("d");
  expect(r.entries[0]?.type).toBe("directory");
});
