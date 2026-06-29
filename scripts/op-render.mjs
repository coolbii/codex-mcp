#!/usr/bin/env node
/**
 * op-render.mjs — acceptance helper for the OpenPencil visual-review renderer.
 *
 * Renders an .op file (or the live OpenPencil canvas) to a PNG using the SAME
 * approximate renderer that the `openpencil_screenshot` MCP tool uses, so you can
 * compare it side-by-side against the real OpenPencil editor and judge whether the
 * render is faithful enough to trust the visual-review loop.
 *
 * Run `npm run build` first (this imports the compiled dist).
 *
 * Usage:
 *   node scripts/op-render.mjs <file.op>            # render the whole file
 *   node scripts/op-render.mjs <file.op> <nodeId>   # crop to one frame/screen
 *   node scripts/op-render.mjs --live               # render the live canvas (needs `op start`)
 *   node scripts/op-render.mjs --live <nodeId>      # crop a live-canvas node
 *   OP=/path/to/op node scripts/op-render.mjs ...   # override the CLI binary
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { renderOpenPencilPng } from "../dist/openpencil-render.js";

const argv = process.argv.slice(2);
const cli = process.env.OP || "op";
const live = argv.includes("--live");
const positional = argv.filter((a) => !a.startsWith("--"));
const file = live ? null : positional[0];
const nodeId = live ? positional[0] : positional[1];

if (!live && !file) {
  console.error("usage: node scripts/op-render.mjs <file.op> [nodeId]   |   node scripts/op-render.mjs --live [nodeId]");
  process.exit(2);
}

const args = ["read-nodes"];
if (nodeId) args.push(nodeId);
args.push("--depth", "50");
if (file) args.push("--file", file);

let out;
try {
  out = execFileSync(cli, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
} catch (err) {
  console.error(`'${cli} ${args.join(" ")}' failed:`, err.stderr || err.message);
  if (live) console.error("Reading the live canvas needs OpenPencil running: `op start --web` (or --desktop).");
  process.exit(1);
}

let nodes;
try {
  nodes = JSON.parse(out).nodes;
} catch {
  console.error("op read-nodes did not return JSON. First 400 chars:\n", out.slice(0, 400));
  process.exit(1);
}
if (!Array.isArray(nodes) || nodes.length === 0) {
  console.error("No nodes returned — is the file/canvas empty?");
  process.exit(1);
}

const r = await renderOpenPencilPng(nodes, { ...(nodeId ? { targetId: nodeId } : {}), maxDimension: 2000 });
const outPath = `op-preview${nodeId ? "-" + nodeId.replace(/[^\w.-]/g, "_") : ""}.png`;
writeFileSync(outPath, r.png);
console.log(
  `wrote ${outPath} — ${r.width}x${r.height}px, ${r.nodeCount} nodes` +
    (r.targetName ? `, cropped to "${r.targetName}"` : ""),
);
