#!/usr/bin/env node
/**
 * make-vision-probe.mjs — generate the Layer-3 Probe-A vision trap (.op).
 *
 * Three colored section banners; the MIDDLE one has its Banner BG as the FIRST
 * child, so it paints on TOP and hides its own title (the literal ORCHID-7741).
 * The title exists in the node JSON but is invisible in the rendered pixels — so a
 * model that reads node JSON answers WRONG, and a model that truly sees the
 * screenshot reports the middle band as occluded. See docs/openpencil-layer3-test.md.
 *
 * Usage: node scripts/make-vision-probe.mjs [outPath.op]
 *   default outPath: /Users/hezibin/bindev/devspace-sandbox/vision-probe.op
 *   (the sandbox ROOT — the workspace ChatGPT opens — so the screenshot path is
 *   just "vision-probe.op", not "designs/vision-probe.op".)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = process.argv[2] || "/Users/hezibin/bindev/devspace-sandbox/vision-probe.op";
const TRAP_TITLE = "ORCHID-7741";
const paint = (color) => [{ type: "solid", color }];
const txt = (id, name, x, y, w, h, content, color, weight, size) =>
  ({ id, type: "text", name, x, y, width: w, height: h, fill: paint(color), fontFamily: "Inter", fontWeight: weight, fontSize: size, content });

const band = (id, idx, title, color, chip, y, bannerFirst) => {
  const bg = { id: `${id}-bg`, type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill: paint(color) };
  const content = [
    { id: `${id}-chip`, type: "rectangle", name: "Index Chip", x: 40, y: 20, width: 88, height: 56, fill: paint(chip) },
    txt(`${id}-num`, "Index Number", 40, 32, 88, 36, idx, "#FFFFFF", 700, 28),
    txt(`${id}-title`, "Section Title", 152, 26, 700, 44, title, "#FFFFFF", 700, 34),
  ];
  // Correct band: Banner BG LAST (paints behind). Trap band: Banner BG FIRST (paints on top).
  const children = bannerFirst ? [bg, ...content] : [...content, bg];
  const label = title === TRAP_TITLE ? "Foundations" : title;
  return { id, type: "frame", name: `Section / ${idx} ${label}`, x: 0, y, width: 1200, height: 96, fill: paint("#F8FAFC"), children };
};

const doc = {
  version: "1.0.0",
  name: "vision-probe",
  pages: [{ id: "p", name: "Page 1", children: [
    band("s00", "00", "Brief", "#1F2937", "#111827", 0, false),
    band("s04", "04", TRAP_TITLE, "#0F766E", "#115E59", 200, true), // trap: teal banner hides the title
    band("s07", "07", "Screens", "#BE123C", "#9F1239", 400, false),
  ] }],
  children: [],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc));
console.log(`wrote ${OUT}`);
console.log(`trap: middle band (Section 04) title "${TRAP_TITLE}" must be HIDDEN behind teal #0F766E`);
