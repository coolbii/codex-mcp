import { afterEach, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixture, type Fixture } from "./helpers.js";
import { detectPackageManager, installArgs, installPackages, PackageInstallError } from "../src/package-tools.js";
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

it("detects package manager from packageManager field before lockfiles", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), JSON.stringify({ packageManager: "yarn@4.3.1" }), "utf8");
  await writeFile(join(fx.root, "package-lock.json"), "{}", "utf8");

  await expect(detectPackageManager(fx.root)).resolves.toBe("yarn");
});

it("builds install args with scripts disabled", () => {
  expect(installArgs("npm", ["react"], false)).toEqual(["install", "--ignore-scripts", "--save", "react"]);
  expect(installArgs("pnpm", ["vitest"], true)).toEqual(["pnpm", "add", "--ignore-scripts", "-D", "vitest"]);
  expect(installArgs("bun", ["lucide-react"], false)).toEqual(["add", "--ignore-scripts", "lucide-react"]);
});

it("uses the version-correct yarn script-suppression flag", () => {
  // yarn classic (default / 1.x) honors --ignore-scripts; berry (2+) errors on it
  // and uses --mode=skip-build instead. Picking the wrong one was a real RCE.
  expect(installArgs("yarn", ["@types/node"], true, 1)).toEqual([
    "yarn", "add", "--ignore-scripts", "--dev", "@types/node",
  ]);
  expect(installArgs("yarn", ["@types/node"], true)).toEqual([
    "yarn", "add", "--ignore-scripts", "--dev", "@types/node",
  ]); // default = classic
  expect(installArgs("yarn", ["@types/node"], true, 4)).toEqual([
    "yarn", "add", "--mode=skip-build", "--dev", "@types/node",
  ]);
});

it("refuses when package installation is disabled", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), "{}", "utf8");

  await expect(
    installPackages(cfg({ enablePackageInstall: false }), fx.guard, fx.ws, { packages: ["react"] }),
  ).rejects.toBeInstanceOf(PackageInstallError);
});

it("rejects non-registry package specs", async () => {
  fx = await makeFixture();
  await writeFile(join(fx.root, "package.json"), "{}", "utf8");

  await expect(
    installPackages(cfg({ enablePackageInstall: true }), fx.guard, fx.ws, {
      packages: ["https://example.com/pkg.tgz"],
    }),
  ).rejects.toThrow(/Invalid package spec/);
});
