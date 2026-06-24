import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, createAppCommand, createIsolatedAppCommand, CreateAppError } from "../src/app-tools.js";
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
    projectsRoot: null,
    denyPaths: [],
    secretScan: true,
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

it("builds fixed isolated app commands", () => {
  expect(createIsolatedAppCommand({ appName: "demo", framework: "next" })).toEqual({
    command: "devspace:create-isolated-app",
    args: ["next", "demo"],
  });

  expect(createIsolatedAppCommand({ appName: "demo", framework: "next", directory: "apps", dryRun: true })).toEqual({
    command: "devspace:create-isolated-app",
    args: ["next", "demo", "--directory=apps", "--dry-run"],
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

it("creates an isolated Nx Next workspace without requiring a healthy root project graph", async () => {
  fx = await makeFixture();
  await writeFile(
    join(fx.root, "package.json"),
    JSON.stringify({
      packageManager: "yarn@4.3.1",
      dependencies: { next: "14.2.3", react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { nx: "19.4.1", "@nx/next": "^19.5.0", typescript: "^5.5.3" },
    }),
    "utf8",
  );

  const r = await createApp(cfg({ enableAppScaffold: true }), fx.guard, fx.ws, {
    appName: "scroll-trigger-demo",
    framework: "next",
    mode: "isolated",
  });

  expect(r.mode).toBe("isolated");
  expect(r.exitCode).toBe(0);
  expect(r.workspaceRoot).toBe(join(fx.root, "devspace-apps", "scroll-trigger-demo"));
  expect(r.generatedFiles).toContain("package.json");
  expect(r.generatedFiles).toContain("yarn.lock");
  expect(r.generatedFiles).toContain(join("apps", "scroll-trigger-demo", "src", "app", "page.tsx"));
  await expect(stat(join(r.workspaceRoot, "nx.json"))).resolves.toBeTruthy();
  await expect(stat(join(r.workspaceRoot, "yarn.lock"))).resolves.toBeTruthy();
  const packageJson = JSON.parse(await readFile(join(r.workspaceRoot, "package.json"), "utf8")) as {
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(packageJson.packageManager).toBe("yarn@4.3.1");
  expect(packageJson.dependencies?.next).toBe("14.2.35");
  expect(packageJson.devDependencies?.nx).toBe("19.4.1");
  expect(packageJson.devDependencies?.["@nx/next"]).toBe("19.4.1");
});

it("defaults to isolated app creation when mode is omitted", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" }), "utf8");

  const r = await createApp(cfg({ enableAppScaffold: true }), fx.guard, fx.ws, {
    appName: "default-demo",
    framework: "next",
  });

  expect(r.mode).toBe("isolated");
  expect(r.workspaceRoot).toBe(join(fx.root, "devspace-apps", "default-demo"));
  await expect(stat(join(r.workspaceRoot, "package.json"))).resolves.toBeTruthy();
});

it("dry-runs isolated app creation without creating folders", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" }), "utf8");

  const r = await createApp(cfg({ enableAppScaffold: true }), fx.guard, fx.ws, {
    appName: "demo",
    framework: "next",
    mode: "isolated",
    dryRun: true,
  });

  expect(r.workspaceRoot).toBe(join(fx.root, "devspace-apps", "demo"));
  await expect(stat(join(fx.root, "devspace-apps"))).rejects.toMatchObject({ code: "ENOENT" });
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
      mode: "existing",
    }),
  ).rejects.toThrow(/Local Nx binary not found/);
});
