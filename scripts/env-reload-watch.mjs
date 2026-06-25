#!/usr/bin/env node
/**
 * env-reload-watch.mjs — restart a launchd-managed devspace when its .env changes.
 *
 * devspace reads .env once at process start (node --env-file). To make an .env
 * edit take effect without a manual `launchctl kickstart`, this watcher monitors
 * the WORKING DIRECTORY (not the file directly — that survives editors that save
 * via write-temp + rename) for changes to `.env`, debounces a burst of save
 * events, then kickstarts the service for a clean ~1s restart. The OAuth store is
 * persisted on disk, so connected ChatGPT sessions reconnect without re-auth.
 *
 * Usage: node scripts/env-reload-watch.mjs [dir=cwd] [launchd-label=com.bin-hq.devspace]
 */
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? process.cwd());
const label = process.argv[3] ?? "com.bin-hq.devspace";
const uid = process.getuid?.() ?? 0;
let timer = null;

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

function restart() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // Validate the NEW .env before restarting. A typo (e.g. a non-existent
    // ALLOWED_ROOTS path) makes loadConfig throw at startup, and launchd would
    // crash-loop the live server. Instead: keep the current process up + log.
    execFile(
      process.execPath,
      [
        "--env-file=.env",
        "--input-type=module",
        "-e",
        "import('./dist/config.js').then(m => m.loadConfig({ transport: 'http', warn() {} })).catch(e => { console.error(e.message); process.exit(1); })",
      ],
      { cwd: dir },
      (vErr, _vo, vStderr) => {
        if (vErr) {
          const reason = (vStderr || vErr.message).trim().split("\n").pop();
          log(`.env changed but INVALID — keeping current server up. ${reason}`);
          return;
        }
        execFile("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], (err, _out, stderr) => {
          log(`.env changed (valid) → kickstart ${label}: ${err ? "ERR " + (stderr || err.message).trim() : "ok"}`);
        });
      },
    );
  }, 600);
}

watch(dir, { persistent: true }, (_event, filename) => {
  if (filename === ".env") restart();
});

log(`watching ${dir}/.env → restarts ${label} on change`);
