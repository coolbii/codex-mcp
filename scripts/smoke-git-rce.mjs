/**
 * Regression smoke for the git on-disk-config RCE (security review finding
 * #git-config-rce-onfile). Proves two layers:
 *   1. RUNTIME: even if a malicious .git/config (core.fsmonitor=<cmd>) exists,
 *      the server's GIT_HARDENING_ARGS make `git status`/`git diff` NOT run it.
 *   2. BOUNDARY: the write tools refuse to create .git/config in the first place.
 * Run after `npm run build`:  node scripts/smoke-git-rce.mjs
 */
import { runCommand } from "../dist/shell-tools.js";
import { writeFile as wf } from "../dist/edit-tools.js";
import { PathGuard } from "../dist/path-guard.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const root = realpathSync(mkdtempSync(join(tmpdir(), "devspace-rce-")));
try {
  execFileSync("git", ["init", "-q"], { cwd: root });

  // A tracked + modified file so `git diff` actually exercises the diff machinery
  // (this is what the diff.external= regression broke).
  writeFileSync(join(root, "f.txt"), "one\n");
  execFileSync("git", ["add", "f.txt"], { cwd: root });
  writeFileSync(join(root, "f.txt"), "one\ntwo\n");

  // Plant a malicious on-disk config (simulating an attacker who obtained a write
  // some OTHER way) so we test the runtime hardening independently. Keep the
  // repo-format key so git still treats the dir as a valid repo.
  const marker = join(root, "RCE_PROOF").replaceAll("\\", "/");
  writeFileSync(
    join(root, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch ${marker}; false"\n`,
  );

  const cfg = {
    enableShell: true,
    shellMode: "restricted",
    shellTimeoutMs: 10_000,
    shellMaxOutputBytes: 200_000,
  };
  const ws = { id: "t", root, openedAt: 0 };

  const status = await runCommand(cfg, ws, "git", ["status"]);
  const diff = await runCommand(cfg, ws, "git", ["diff"]);
  console.log("git status exit:", status.exitCode, "| git diff exit:", diff.exitCode);

  assert(
    !existsSync(join(root, "RCE_PROOF")),
    "❌ RCE FIRED — on-disk core.fsmonitor executed despite hardening",
  );
  console.log("✅ runtime: on-disk .git/config fsmonitor did NOT execute");

  // Regression guard: `git diff` must still work (not die with exit 128).
  assert(diff.exitCode === 0, `❌ git diff regressed (exit ${diff.exitCode})`);
  assert(diff.stdout.includes("+two"), "❌ git diff produced no diff output");
  console.log("✅ regression: git diff returns a unified diff (exit 0)");

  // Boundary: the write tools must refuse to plant .git/config.
  const guard = new PathGuard([root]);
  let denied = false;
  try {
    await wf(guard, ws, ".git/config", "[core]\n  fsmonitor = evil\n");
  } catch {
    denied = true;
  }
  assert(denied, "❌ write_file('.git/config') was ALLOWED");
  console.log("✅ boundary: write_file('.git/config') refused");

  console.log("\n✅ git RCE regression smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
