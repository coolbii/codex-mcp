import { it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile, symlink } from "node:fs/promises";
import { makeFixture, type Fixture } from "./helpers.js";
import { findFiles, searchFiles } from "../src/search-tools.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

it("finds files by glob", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.ts"), "x");
  await writeFile(join(fx.root, "b.js"), "y");
  const r = await findFiles(fx.guard, fx.ws, "**/*.ts");
  expect(r.files).toEqual(["a.ts"]);
});

it("searches file contents and reports line numbers", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.txt"), "foo\nNEEDLE here\nbar\n");
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "NEEDLE",
    maxResults: 100,
    maxFileBytes: 1_000_000,
  });
  expect(r.matches.length).toBe(1);
  expect(r.matches[0]?.lineNumber).toBe(2);
});

it("respects .gitignore", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(fx.root, "ignored.txt"), "NEEDLE");
  await writeFile(join(fx.root, "kept.txt"), "NEEDLE");
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "NEEDLE",
    maxResults: 100,
    maxFileBytes: 1_000_000,
  });
  const files = r.matches.map((m) => m.file);
  expect(files).toContain("kept.txt");
  expect(files).not.toContain("ignored.txt");
});

it("skips dotfiles by default (does not surface .env)", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, ".env"), "SECRET=NEEDLE");
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "NEEDLE",
    maxResults: 100,
    maxFileBytes: 1_000_000,
  });
  expect(r.matches.length).toBe(0);
});

it("does not follow symlinks out of the root", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.base, "secret.txt"), "NEEDLE");
  await symlink(join(fx.base, "secret.txt"), join(fx.root, "link.txt"));
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "NEEDLE",
    maxResults: 100,
    maxFileBytes: 1_000_000,
  });
  expect(r.matches.length).toBe(0);
});

it("does NOT hang on a catastrophic regex (settles, never freezes)", async () => {
  fx = await makeFixture();
  // A classic ReDoS trigger for backtracking engines.
  await writeFile(join(fx.root, "a.txt"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX\n");
  const run = searchFiles(fx.guard, fx.ws, {
    query: "(a+)+$",
    isRegex: true,
    maxResults: 100,
    maxFileBytes: 1_000_000,
  })
    .then(() => "settled")
    .catch(() => "settled"); // re2 returns fast OR regex is refused fast — both fine
  const outcome = await Promise.race([
    run,
    new Promise<string>((res) => setTimeout(() => res("hung"), 4000)),
  ]);
  expect(outcome).toBe("settled");
});

it("matches a simple regex when re2 is available", async () => {
  const re2 = await import("re2").then((m) => m.default).catch(() => null);
  if (!re2) return; // re2 optional — the fail-closed path is covered above
  fx = await makeFixture();
  await writeFile(join(fx.root, "a.txt"), "foo123bar\n");
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "[0-9]+",
    isRegex: true,
    maxResults: 100,
    maxFileBytes: 1_000_000,
  });
  expect(r.matches.length).toBe(1);
});
