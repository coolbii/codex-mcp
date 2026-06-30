#!/usr/bin/env node
/**
 * fetch-fonts.mjs — download the large CJK fonts the OpenPencil renderer uses for
 * Chinese text. Inter (Latin) is committed in assets/fonts; the multi-MB Noto CJK
 * fonts are fetched here instead of bloating git history, and are gitignored.
 *
 * Usage:
 *   npm run fetch-fonts            # Noto Sans TC (Traditional, default)
 *   node scripts/fetch-fonts.mjs sc        # Simplified
 *   node scripts/fetch-fonts.mjs tc sc     # both
 *   node scripts/fetch-fonts.mjs tc --force
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
mkdirSync(dir, { recursive: true });

const FONTS = {
  tc: { name: "NotoSansTC.ttf", url: "https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf" },
  sc: { name: "NotoSansSC.ttf", url: "https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf" },
};

const args = process.argv.slice(2);
const force = args.includes("--force");
const keys = args.filter((a) => !a.startsWith("-"));
const want = keys.length ? keys : ["tc"];

let failed = false;
for (const key of want) {
  const font = FONTS[key];
  if (!font) {
    console.error(`unknown font "${key}" (use: tc, sc)`);
    failed = true;
    continue;
  }
  const out = join(dir, font.name);
  if (existsSync(out) && !force) {
    console.log(`exists: ${font.name} (use --force to re-download)`);
    continue;
  }
  console.log(`downloading ${font.name} ...`);
  const res = await fetch(font.url);
  if (!res.ok) {
    console.error(`failed: ${res.status} ${font.url}`);
    failed = true;
    continue;
  }
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${out}`);
}
process.exitCode = failed ? 1 : 0;
