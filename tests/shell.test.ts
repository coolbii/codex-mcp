import { it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, type Fixture } from "./helpers.js";
import { runCommand, ShellError } from "../src/shell-tools.js";
import type { AppConfig } from "../src/config.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

function cfg(over: Partial<AppConfig>): AppConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    publicBaseUrl: null,
    allowedRoots: [],
    rawAllowedRoots: [],
    requireAuth: false,
    ownerToken: "",
    ownerTokenGenerated: false,
    authMode: "owner_token",
    oauthStorePath: "/tmp/devspace-oauth-test.json",
    enableDnsRebindingProtection: true,
    allowedHosts: [],
    allowedOrigins: [],
    enableShell: false,
    shellMode: "restricted",
    logShellCommands: false,
    enablePackageInstall: false,
    maxReadBytes: 1_000_000,
    maxSearchMatches: 500,
    maxSearchFileBytes: 5_000_000,
    shellTimeoutMs: 30_000,
    shellMaxOutputBytes: 200_000,
    ...over,
  };
}

it("refuses when the shell is disabled", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: false }), fx.ws, "git", ["status"]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("restricted mode rejects a non-allowlisted binary", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: true, shellMode: "restricted" }), fx.ws, "npm", ["test"]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("restricted mode rejects a disallowed git subcommand", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: true, shellMode: "restricted" }), fx.ws, "git", ["push"]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("restricted mode rejects a dangerous git flag (-c)", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: true, shellMode: "restricted" }), fx.ws, "git", [
      "-c",
      "x=y",
      "status",
    ]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("rejects a command containing path separators", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: true, shellMode: "unrestricted" }), fx.ws, "/bin/echo", ["hi"]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("rejects an argument containing a NUL byte", async () => {
  fx = await makeFixture();
  await expect(
    runCommand(cfg({ enableShell: true, shellMode: "unrestricted" }), fx.ws, "echo", ["a\0b"]),
  ).rejects.toBeInstanceOf(ShellError);
});

it("unrestricted mode runs a real command and captures stdout", async () => {
  fx = await makeFixture();
  const r = await runCommand(
    cfg({ enableShell: true, shellMode: "unrestricted" }),
    fx.ws,
    "echo",
    ["hello"],
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("hello");
});

it("does not leak secrets into the child environment", async () => {
  fx = await makeFixture();
  process.env.DEVSPACE_TEST_SECRET = "leaky";
  try {
    const r = await runCommand(
      cfg({ enableShell: true, shellMode: "unrestricted" }),
      fx.ws,
      "printenv",
      ["DEVSPACE_TEST_SECRET"],
    );
    // printenv exits non-zero and prints nothing when the var is absent.
    expect(r.stdout.trim()).toBe("");
  } finally {
    delete process.env.DEVSPACE_TEST_SECRET;
  }
});

it("enforces a timeout", async () => {
  fx = await makeFixture();
  const r = await runCommand(
    cfg({ enableShell: true, shellMode: "unrestricted", shellTimeoutMs: 200 }),
    fx.ws,
    "sleep",
    ["5"],
  );
  expect(r.timedOut).toBe(true);
});

it("restricted 'git diff' returns a unified diff, not exit 128 (R1 regression)", async () => {
  fx = await makeFixture();
  execFileSync("git", ["init", "-q"], { cwd: fx.root });
  writeFileSync(join(fx.root, "f.txt"), "one\n");
  execFileSync("git", ["add", "f.txt"], { cwd: fx.root });
  writeFileSync(join(fx.root, "f.txt"), "one\ntwo\n"); // unstaged change
  const r = await runCommand(
    cfg({ enableShell: true, shellMode: "restricted" }),
    fx.ws,
    "git",
    ["diff"],
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("+two");
});
