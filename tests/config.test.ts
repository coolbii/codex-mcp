import { describe, it, expect } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

async function tmp(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "devspace-cfg-")));
}
const silent = (): void => {};

describe("loadConfig — allowed roots", () => {
  it("accepts a narrow temp dir", async () => {
    const dir = await tmp();
    const cfg = loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: dir }, warn: silent });
    expect(cfg.allowedRoots).toContain(dir);
  });
  it("requires ALLOWED_ROOTS", () => {
    expect(() => loadConfig({ transport: "stdio", env: {}, warn: silent })).toThrow(ConfigError);
  });
  it("rejects the home directory", () => {
    expect(() =>
      loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: homedir() }, warn: silent }),
    ).toThrow(/home/i);
  });
  it("rejects the filesystem root", () => {
    expect(() =>
      loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: "/" }, warn: silent }),
    ).toThrow(ConfigError);
  });
  it("rejects a root that contains the home directory", () => {
    expect(() =>
      loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: dirname(homedir()) }, warn: silent }),
    ).toThrow(ConfigError);
  });
  it("rejects a nonexistent root", () => {
    expect(() =>
      loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: "/no/such/dir/xyzzy" }, warn: silent }),
    ).toThrow(ConfigError);
  });
  it("rejects a bare repo / git directory as a root", async () => {
    const dir = await tmp();
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "objects"));
    mkdirSync(join(dir, "refs"));
    expect(() =>
      loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: dir }, warn: silent }),
    ).toThrow(/git directory|bare/i);
  });
});

describe("loadConfig — auth", () => {
  it("http generates an owner token when none is provided", async () => {
    const dir = await tmp();
    const cfg = loadConfig({ transport: "http", env: { ALLOWED_ROOTS: dir }, warn: silent });
    expect(cfg.requireAuth).toBe(true);
    expect(cfg.ownerTokenGenerated).toBe(true);
    expect(cfg.ownerToken.length).toBeGreaterThanOrEqual(32);
  });
  it("http rejects a short owner token", async () => {
    const dir = await tmp();
    expect(() =>
      loadConfig({ transport: "http", env: { ALLOWED_ROOTS: dir, OWNER_TOKEN: "short" }, warn: silent }),
    ).toThrow(ConfigError);
  });
  it("stdio does not require auth", async () => {
    const dir = await tmp();
    const cfg = loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: dir }, warn: silent });
    expect(cfg.requireAuth).toBe(false);
  });
  it("allows insecure-local opt-out on loopback", async () => {
    const dir = await tmp();
    const cfg = loadConfig({
      transport: "http",
      env: { ALLOWED_ROOTS: dir, ALLOW_INSECURE_LOCAL: "1" },
      warn: silent,
    });
    expect(cfg.requireAuth).toBe(false);
  });
  it("rejects insecure-local opt-out together with a public URL", async () => {
    const dir = await tmp();
    expect(() =>
      loadConfig({
        transport: "http",
        env: { ALLOWED_ROOTS: dir, ALLOW_INSECURE_LOCAL: "1", PUBLIC_BASE_URL: "https://x.example.com" },
        warn: silent,
      }),
    ).toThrow(ConfigError);
  });
});

describe("loadConfig — shell", () => {
  it("shell is disabled by default", async () => {
    const dir = await tmp();
    const cfg = loadConfig({ transport: "stdio", env: { ALLOWED_ROOTS: dir }, warn: silent });
    expect(cfg.enableShell).toBe(false);
  });
  it("unrestricted mode requires the gate flag", async () => {
    const dir = await tmp();
    expect(() =>
      loadConfig({
        transport: "stdio",
        env: { ALLOWED_ROOTS: dir, ENABLE_SHELL: "1", SHELL_MODE: "unrestricted" },
        warn: silent,
      }),
    ).toThrow(ConfigError);
  });
  it("unrestricted allowed with the gate flag and no tunnel", async () => {
    const dir = await tmp();
    const cfg = loadConfig({
      transport: "stdio",
      env: {
        ALLOWED_ROOTS: dir,
        ENABLE_SHELL: "1",
        SHELL_MODE: "unrestricted",
        ALLOW_UNRESTRICTED_SHELL: "1",
      },
      warn: silent,
    });
    expect(cfg.shellMode).toBe("unrestricted");
  });
});

describe("loadConfig — public URL", () => {
  it("rejects a URL that includes a path", async () => {
    const dir = await tmp();
    expect(() =>
      loadConfig({
        transport: "http",
        env: { ALLOWED_ROOTS: dir, OWNER_TOKEN: "x".repeat(40), PUBLIC_BASE_URL: "https://x.example.com/mcp" },
        warn: silent,
      }),
    ).toThrow(ConfigError);
  });
  it("accepts an https origin", async () => {
    const dir = await tmp();
    const cfg = loadConfig({
      transport: "http",
      env: { ALLOWED_ROOTS: dir, OWNER_TOKEN: "x".repeat(40), PUBLIC_BASE_URL: "https://x.example.com" },
      warn: silent,
    });
    expect(cfg.publicBaseUrl).toBe("https://x.example.com");
  });
});
