import { afterEach, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, createAppCommand, CreateAppError } from "../src/app-tools.js";
import { makeFixture, type Fixture } from "./helpers.js";
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
    enableAppScaffold: false,
    maxReadBytes: 1_000_000,
    maxSearchMatches: 500,
    maxSearchFileBytes: 5_000_000,
    shellTimeoutMs: 30_000,
    shellMaxOutputBytes: 200_000,
    ...over,
  };
}

it("builds fixed Nx generator commands", () => {
  expect(createAppCommand("/repo/node_modules/.bin/nx", { appName: "admin", framework: "next" })).toEqual({
    command: "/repo/node_modules/.bin/nx",
    args: ["g", "@nx/next:app", "admin", "--no-interactive"],
  });

  expect(
    createAppCommand("/repo/node_modules/.bin/nx", {
      appName: "ops-dashboard",
      framework: "react",
      directory: "apps",
      dryRun: true,
    }),
  ).toEqual({
    command: "/repo/node_modules/.bin/nx",
    args: ["g", "@nx/react:app", "ops-dashboard", "--no-interactive", "--directory=apps", "--dry-run"],
  });
});

it("refuses when Nx app scaffolding is disabled", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), "{}", "utf8");
  await writeFile(join(fx.root, "nx.json"), "{}", "utf8");

  await expect(
    createApp(cfg({ enableAppScaffold: false }), fx.guard, fx.ws, {
      appName: "admin",
      framework: "next",
    }),
  ).rejects.toBeInstanceOf(CreateAppError);
});

it("refuses to download Nx through npx or bunx", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" }), "utf8");
  await writeFile(join(fx.root, "nx.json"), "{}", "utf8");
  await mkdir(join(fx.root, "node_modules", ".bin"), { recursive: true });

  await expect(
    createApp(cfg({ enableAppScaffold: true }), fx.guard, fx.ws, {
      appName: "admin",
      framework: "next",
    }),
  ).rejects.toThrow(/Local Nx binary not found/);
});
