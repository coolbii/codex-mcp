import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir, symlink } from "node:fs/promises";
import { makeFixture, type Fixture } from "./helpers.js";
import { AccessDeniedError, PathGuard } from "../src/path-guard.js";
import { CASE_INSENSITIVE_FS } from "../src/path-util.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

describe("PathGuard.resolveForRead", () => {
  it("resolves a normal file to its realpath", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "a.txt"), "hi");
    const real = await fx.guard.resolveForRead(fx.root, "a.txt");
    expect(real).toBe(join(fx.root, "a.txt"));
  });

  it("allows '..' that stays inside the workspace", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.root, "sub"), { recursive: true });
    await writeFile(join(fx.root, "a.txt"), "hi");
    const real = await fx.guard.resolveForRead(fx.root, "sub/../a.txt");
    expect(real).toBe(join(fx.root, "a.txt"));
  });

  it("rejects traversal that escapes the workspace", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.base, "secret.txt"), "TOPSECRET");
    await expect(fx.guard.resolveForRead(fx.root, "../secret.txt")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects a symlink that points outside the workspace", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.base, "secret.txt"), "TOPSECRET");
    await symlink(join(fx.base, "secret.txt"), join(fx.root, "link"));
    await expect(fx.guard.resolveForRead(fx.root, "link")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("allows a symlink that points inside the workspace", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.root, "real.txt"), "ok");
    await symlink(join(fx.root, "real.txt"), join(fx.root, "alias"));
    const real = await fx.guard.resolveForRead(fx.root, "alias");
    expect(real).toBe(join(fx.root, "real.txt"));
  });

  it("rejects an absolute path outside the workspace", async () => {
    fx = await makeFixture();
    await expect(fx.guard.resolveForRead(fx.root, "/etc/hosts")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects a nonexistent file", async () => {
    fx = await makeFixture();
    await expect(fx.guard.resolveForRead(fx.root, "nope.txt")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });
});

describe("PathGuard.resolveForWrite", () => {
  it("allows a new file in an existing dir inside the workspace", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.root, "sub"), { recursive: true });
    const target = await fx.guard.resolveForWrite(fx.root, "sub/new.txt");
    expect(target).toBe(join(fx.root, "sub", "new.txt"));
  });

  it("rejects writing when the parent dir does not exist", async () => {
    fx = await makeFixture();
    await expect(fx.guard.resolveForWrite(fx.root, "missing/new.txt")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects writing through a symlink that escapes the workspace", async () => {
    fx = await makeFixture();
    await writeFile(join(fx.base, "secret.txt"), "TOPSECRET");
    await symlink(join(fx.base, "secret.txt"), join(fx.root, "link"));
    await expect(fx.guard.resolveForWrite(fx.root, "link")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects writing outside the workspace via '..'", async () => {
    fx = await makeFixture();
    await expect(fx.guard.resolveForWrite(fx.root, "../escape.txt")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects writing through a parent symlink that escapes", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.base, "outside"), { recursive: true });
    await symlink(join(fx.base, "outside"), join(fx.root, "linkdir"));
    await expect(fx.guard.resolveForWrite(fx.root, "linkdir/new.txt")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });
});

describe("PathGuard — git config write denial (RCE defense)", () => {
  it("rejects writing .git/config", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.root, ".git"), { recursive: true });
    await expect(fx.guard.resolveForWrite(fx.root, ".git/config")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects writing a nested .git/hooks file", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.root, "sub", ".git", "hooks"), { recursive: true });
    await expect(
      fx.guard.resolveForWrite(fx.root, "sub/.git/hooks/pre-commit"),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("rejects writing .gitattributes", async () => {
    fx = await makeFixture();
    await expect(fx.guard.resolveForWrite(fx.root, ".gitattributes")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("rejects the case-variant .GIT/config on case-insensitive filesystems", async () => {
    if (!CASE_INSENSITIVE_FS) return; // only a bypass risk on case-insensitive volumes
    fx = await makeFixture();
    await mkdir(join(fx.root, ".GIT"), { recursive: true });
    await expect(fx.guard.resolveForWrite(fx.root, ".GIT/config")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it("still allows a normal file", async () => {
    fx = await makeFixture();
    const target = await fx.guard.resolveForWrite(fx.root, "ok.txt");
    expect(target).toBe(join(fx.root, "ok.txt"));
  });
});

describe("PathGuard — READONLY_ROOTS (read-only roots)", () => {
  it("reads from a read-only root but refuses writes there", async () => {
    fx = await makeFixture();
    await mkdir(join(fx.root, "ro"), { recursive: true });
    await writeFile(join(fx.root, "ro", "strategy.py"), "print('hi')");
    // Guard where <root>/ro is read-only.
    const guard = new PathGuard([fx.root], [join(fx.root, "ro")]);

    // Reads still work.
    const real = await guard.resolveForRead(fx.root, "ro/strategy.py");
    expect(real).toBe(join(fx.root, "ro", "strategy.py"));

    // Writes under the read-only root are refused...
    await expect(guard.resolveForWrite(fx.root, "ro/strategy.py")).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(guard.resolveForWrite(fx.root, "ro/new.py")).rejects.toThrow(/read-only/i);

    // ...but writes elsewhere in the workspace are fine.
    const ok = await guard.resolveForWrite(fx.root, "scratch.txt");
    expect(ok).toBe(join(fx.root, "scratch.txt"));
  });
});
