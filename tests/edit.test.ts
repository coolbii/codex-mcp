import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { makeFixture, type Fixture } from "./helpers.js";
import {
  applyExactEdits,
  writeFile as wf,
  editFile,
  showDiff,
  EditError,
} from "../src/edit-tools.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

describe("applyExactEdits", () => {
  it("replaces a unique match", () => {
    expect(applyExactEdits("hello world", [{ oldText: "world", newText: "there" }])).toBe(
      "hello there",
    );
  });
  it("throws when oldText is not found", () => {
    expect(() => applyExactEdits("abc", [{ oldText: "x", newText: "y" }])).toThrow(EditError);
  });
  it("throws when oldText is not unique", () => {
    expect(() => applyExactEdits("a a a", [{ oldText: "a", newText: "b" }])).toThrow(EditError);
  });
  it("replaceAll replaces every occurrence", () => {
    expect(applyExactEdits("a a a", [{ oldText: "a", newText: "b" }], true)).toBe("b b b");
  });
  it("applies multiple edits in order", () => {
    expect(
      applyExactEdits("one two", [
        { oldText: "one", newText: "1" },
        { oldText: "two", newText: "2" },
      ]),
    ).toBe("1 2");
  });
});

describe("writeFile / editFile / showDiff", () => {
  it("creates a new file and returns a diff", async () => {
    fx = await makeFixture();
    const r = await wf(fx.guard, fx.ws, "new.txt", "hello\n");
    expect(r.created).toBe(true);
    expect(await readFile(join(fx.root, "new.txt"), "utf8")).toBe("hello\n");
    expect(r.diff).toContain("hello");
  });

  it("overwrites an existing file atomically", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "f.txt"), "old\n");
    const r = await wf(fx.guard, fx.ws, "f.txt", "new\n");
    expect(r.created).toBe(false);
    expect(await readFile(join(fx.root, "f.txt"), "utf8")).toBe("new\n");
  });

  it("createOnly refuses to overwrite", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "f.txt"), "old\n");
    await expect(wf(fx.guard, fx.ws, "f.txt", "x", { createOnly: true })).rejects.toBeInstanceOf(
      EditError,
    );
  });

  it("editFile applies an exact edit", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "f.txt"), "foo bar\n");
    const r = await editFile(fx.guard, fx.ws, "f.txt", [{ oldText: "bar", newText: "baz" }]);
    expect(await readFile(join(fx.root, "f.txt"), "utf8")).toBe("foo baz\n");
    expect(r.diff).toContain("baz");
  });

  it("showDiff does not modify the file", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "f.txt"), "old\n");
    const r = await showDiff(fx.guard, fx.ws, "f.txt", "new\n");
    expect(r.exists).toBe(true);
    expect(r.diff).toContain("new");
    expect(await readFile(join(fx.root, "f.txt"), "utf8")).toBe("old\n");
  });

  it("refuses to write outside the workspace", async () => {
    fx = await makeFixture();
    await expect(wf(fx.guard, fx.ws, "../escape.txt", "x")).rejects.toThrow();
  });
});
