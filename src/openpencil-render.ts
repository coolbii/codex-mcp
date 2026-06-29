/**
 * openpencil-render.ts — approximate, browser-free rasterizer for .op node trees.
 *
 * OpenPencil's only real renderer is CanvasKit running in the browser preview, and
 * the `op` CLI has no export/screenshot command. To let an AI client *look* at what
 * it authored (a visual-review loop), we re-render the node geometry to SVG in Node
 * and rasterize it with the optional `@resvg/resvg-js` dependency.
 *
 * This is intentionally an *approximate* render of the authored geometry, not a
 * pixel-perfect copy of CanvasKit: it faithfully reveals overlap, misalignment,
 * missing/!colored section banners, empty cells, contrast, and density — which is
 * what "does this look professional to a human" actually hinges on. It does not try
 * to reproduce gradients, shadows, images, or CanvasKit's exact text shaping.
 *
 * Fidelity note: in the current OpenPencil renderer the *last* child of a frame is
 * the backmost layer (that is why the lint requires full-frame backgrounds to be the
 * last child). SVG paints later elements on top, so we paint children in REVERSE
 * order to match OpenPencil's z-order — otherwise a trailing "Banner BG" would cover
 * its own title and the render would mislead the reviewer.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class OpenPencilRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenPencilRenderError";
  }
}

export interface RenderNode {
  id?: string;
  type?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: unknown;
  stroke?: unknown;
  strokeWidth?: number;
  opacity?: number;
  cornerRadius?: number;
  radius?: number;
  borderRadius?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  textAlign?: string;
  letterSpacing?: number;
  color?: unknown;
  content?: string;
  text?: string;
  visible?: boolean;
  children?: RenderNode[] | string;
  [key: string]: unknown;
}

export interface BuildSvgOptions {
  /** Background painted behind everything (transparent regions read as this). */
  background?: string;
  /** Default text color when a text node has no fill. */
  defaultTextColor?: string;
  /** Fallback font stack written into the SVG. */
  defaultFontFamily?: string;
}

export interface BuildSvgResult {
  svg: string;
  width: number;
  height: number;
  targetId: string | null;
  targetName: string | null;
  nodeCount: number;
}

export interface RenderPngOptions extends BuildSvgOptions {
  /** Node id to crop to. Omit to render the union of all top-level nodes. */
  targetId?: string;
  /** Longest output edge in px; the SVG is scaled to fit. Default 1600. */
  maxDimension?: number;
  /** Extra font directories to load (the bundled Inter dir is always included). */
  fontDirs?: string[];
  /** Explicit font files to load. */
  fontFiles?: string[];
}

export interface RenderPngResult {
  png: Buffer;
  width: number;
  height: number;
  targetId: string | null;
  targetName: string | null;
  nodeCount: number;
}

const DEFAULT_BG = "#FFFFFF";
const DEFAULT_TEXT = "#111827";

/** Inter TTFs bundled in <repo>/assets/fonts, resolved relative to this module. */
const BUNDLED_FONT_DIR = ((): string | null => {
  try {
    return fileURLToPath(new URL("../assets/fonts", import.meta.url));
  } catch {
    return null;
  }
})();

/** Bundled Inter dir + optional OPENPENCIL_FONT_DIR (e.g. to drop in Noto Sans SC) + caller dirs. */
function resolveFontDirs(extra?: string[]): string[] {
  const dirs: string[] = [];
  if (BUNDLED_FONT_DIR) dirs.push(BUNDLED_FONT_DIR);
  const envDir = process.env.OPENPENCIL_FONT_DIR;
  if (envDir) dirs.push(envDir);
  if (extra) dirs.push(...extra);
  return dirs.filter((dir) => {
    try {
      return existsSync(dir);
    } catch {
      return false;
    }
  });
}
const DEFAULT_FONT = "Inter, 'Noto Sans SC', system-ui, -apple-system, Segoe UI, sans-serif";
const MAX_LINES = 200;
const MAX_NODES = 20_000;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function childrenOf(node: RenderNode): RenderNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function isVisible(node: RenderNode): boolean {
  return node.visible !== false;
}

/**
 * Extract a solid color string from the many shapes OpenPencil uses for fill/stroke:
 * a string ("#1F2937"), the live CLI's paint array ([{type:"solid",color:"#1F2937"}]),
 * or a paint object ({color}/{hex}/{r,g,b}). Returns the first solid color, or null for
 * gradients/images/empty.
 */
export function solidColorOf(paint: unknown): string | null {
  if (typeof paint === "string") return paint.trim() || null;
  if (Array.isArray(paint)) {
    for (const entry of paint) {
      const c = solidColorOf(entry);
      if (c) return c;
    }
    return null;
  }
  if (paint && typeof paint === "object") {
    const o = paint as Record<string, unknown>;
    if (o.visible === false) return null;
    if (typeof o.color === "string") return o.color.trim() || null;
    if (typeof o.hex === "string") return o.hex.trim() || null;
    if (typeof o.value === "string" && /^(#|rgb|hsl)/i.test(o.value)) return o.value.trim();
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const h = (n: number): string =>
        Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)))
          .toString(16)
          .padStart(2, "0");
      return `#${h(o.r)}${h(o.g)}${h(o.b)}`;
    }
  }
  return null;
}

/** Validate an extracted paint to a CSS color the SVG can use; ignore gradients/objects. */
function colorOf(value: unknown): string | null {
  const v = solidColorOf(value);
  if (!v) return null;
  if (/^#([0-9a-f]{3,8})$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\([0-9.,%\s/]+\)$/i.test(v)) return v;
  if (/^[a-z]+$/i.test(v)) return v; // named color
  return null;
}

function radiusOf(node: RenderNode): number {
  return num(node.cornerRadius) ?? num(node.radius) ?? num(node.borderRadius) ?? 0;
}

function fontWeightOf(node: RenderNode): string {
  const w = node.fontWeight;
  if (typeof w === "number" && Number.isFinite(w)) return String(w);
  if (typeof w === "string" && w.trim()) return w.trim();
  return "400";
}

function textContentOf(node: RenderNode): string {
  if (typeof node.content === "string") return node.content;
  if (typeof node.text === "string") return node.text;
  return "";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Greedy word wrap using the same 0.55*fontSize char-width estimate the lint uses. */
function wrapText(content: string, fontSize: number, maxWidth: number | undefined): string[] {
  const out: string[] = [];
  const paragraphs = content.split("\n");
  const charW = fontSize * 0.55;
  for (const para of paragraphs) {
    if (maxWidth === undefined || maxWidth <= 0 || charW <= 0) {
      out.push(para);
      continue;
    }
    const maxChars = Math.max(1, Math.floor(maxWidth / charW));
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maxChars || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
      if (out.length >= MAX_LINES) break;
    }
    if (line && out.length < MAX_LINES) out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out.length ? out.slice(0, MAX_LINES) : [""];
}

function renderTextNode(node: RenderNode, opts: Required<BuildSvgOptions>, sb: string[]): void {
  const content = textContentOf(node);
  if (!content.trim()) return;
  const fontSize = num(node.fontSize) ?? 14;
  const rawLh = num(node.lineHeight);
  // lineHeight may be px (large) or a multiplier (<= 4). Normalise to px.
  const lineHeight = rawLh === undefined ? Math.round(fontSize * 1.3) : rawLh <= 4 ? Math.round(rawLh * fontSize) : rawLh;
  const family = node.fontFamily?.trim() || opts.defaultFontFamily;
  const weight = fontWeightOf(node);
  const fill = colorOf(node.fill) ?? colorOf(node.color) ?? opts.defaultTextColor;
  const width = num(node.width);
  const align = (node.textAlign ?? "left").toLowerCase();
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const anchorX = align === "center" && width ? width / 2 : align === "right" && width ? width : 0;
  const lines = wrapText(content, fontSize, width);
  const ascent = fontSize * 0.82;
  const familyAttr = family.includes(",") || /\s/.test(family) ? family : `${family}, ${opts.defaultFontFamily}`;
  sb.push(
    `<text font-family="${escapeXml(familyAttr)}" font-size="${fontSize}" font-weight="${escapeXml(weight)}" ` +
      `fill="${escapeXml(fill)}" text-anchor="${anchor}" xml:space="preserve">`,
  );
  lines.forEach((line, i) => {
    const y = ascent + i * lineHeight;
    sb.push(`<tspan x="${anchorX}" y="${y.toFixed(2)}">${escapeXml(line)}</tspan>`);
  });
  sb.push(`</text>`);
}

function renderShape(node: RenderNode, sb: string[]): void {
  const w = num(node.width);
  const h = num(node.height);
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return;
  const fill = colorOf(node.fill);
  const stroke = colorOf(node.stroke);
  if (!fill && !stroke) return;
  const type = (node.type ?? "").toLowerCase();
  const fillAttr = fill ? `fill="${escapeXml(fill)}"` : `fill="none"`;
  const strokeAttr = stroke ? ` stroke="${escapeXml(stroke)}" stroke-width="${num(node.strokeWidth) ?? 1}"` : "";
  if (type === "ellipse" || type === "circle") {
    sb.push(`<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${fillAttr}${strokeAttr} />`);
    return;
  }
  const r = radiusOf(node);
  const rAttr = r > 0 ? ` rx="${Math.min(r, w / 2)}" ry="${Math.min(r, h / 2)}"` : "";
  sb.push(`<rect x="0" y="0" width="${w}" height="${h}"${rAttr} ${fillAttr}${strokeAttr} />`);
}

function renderNode(node: RenderNode, opts: Required<BuildSvgOptions>, sb: string[], counter: { n: number }): void {
  if (!isVisible(node)) return;
  if (counter.n++ > MAX_NODES) return;
  const x = num(node.x) ?? 0;
  const y = num(node.y) ?? 0;
  const opacity = num(node.opacity);
  const opacityAttr = opacity !== undefined && opacity < 1 ? ` opacity="${Math.max(0, opacity)}"` : "";
  const needsGroup = x !== 0 || y !== 0 || opacityAttr !== "";
  if (needsGroup) sb.push(`<g transform="translate(${x} ${y})"${opacityAttr}>`);
  const type = (node.type ?? "").toLowerCase();
  if (type === "text") {
    renderTextNode(node, opts, sb);
  } else {
    renderShape(node, sb);
  }
  // OpenPencil paints the LAST child at the back; SVG paints later elements on top,
  // so render children in reverse to preserve authored z-order.
  const kids = childrenOf(node);
  for (let i = kids.length - 1; i >= 0; i--) {
    const child = kids[i];
    if (child) renderNode(child, opts, sb, counter);
  }
  if (needsGroup) sb.push(`</g>`);
}

/** Absolute bounding box of a node within the page (children x/y are parent-relative). */
function absoluteBox(
  nodes: RenderNode[],
  targetId: string,
  offsetX = 0,
  offsetY = 0,
): { node: RenderNode; x: number; y: number } | null {
  for (const node of nodes) {
    const nx = offsetX + (num(node.x) ?? 0);
    const ny = offsetY + (num(node.y) ?? 0);
    if (node.id === targetId) return { node, x: nx, y: ny };
    const found = absoluteBox(childrenOf(node), targetId, nx, ny);
    if (found) return found;
  }
  return null;
}

function unionBox(nodes: RenderNode[]): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const x = num(node.x) ?? 0;
    const y = num(node.y) ?? 0;
    const w = num(node.width) ?? 0;
    const h = num(node.height) ?? 0;
    if (w > 0 && h > 0) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function countNodes(nodes: RenderNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countNodes(childrenOf(node));
  }
  return total;
}

/**
 * Build an SVG string from an .op node tree. Pure and deterministic (no native deps),
 * so it is unit-testable without `@resvg/resvg-js`.
 */
export function buildSvg(nodes: RenderNode[], options: RenderPngOptions = {}): BuildSvgResult {
  const opts: Required<BuildSvgOptions> = {
    background: options.background ?? DEFAULT_BG,
    defaultTextColor: options.defaultTextColor ?? DEFAULT_TEXT,
    defaultFontFamily: options.defaultFontFamily ?? DEFAULT_FONT,
  };

  let roots: RenderNode[];
  let viewWidth: number;
  let viewHeight: number;
  let targetId: string | null = null;
  let targetName: string | null = null;

  if (options.targetId) {
    const located = absoluteBox(nodes, options.targetId);
    if (!located) throw new OpenPencilRenderError(`Node id "${options.targetId}" was not found in the document.`);
    const w = num(located.node.width);
    const h = num(located.node.height);
    if (w === undefined || h === undefined || w <= 0 || h <= 0) {
      // Fall back to the union of the target's children when it has no own size.
      const u = unionBox(childrenOf(located.node));
      viewWidth = u.width;
      viewHeight = u.height;
    } else {
      viewWidth = w;
      viewHeight = h;
    }
    // Render the target as a local root at the origin (drop its own x/y).
    const localRoot: RenderNode = { ...located.node, x: 0, y: 0 };
    roots = [localRoot];
    targetId = options.targetId;
    targetName = (located.node.name as string) ?? located.node.id ?? null;
  } else {
    const u = unionBox(nodes);
    viewWidth = u.width;
    viewHeight = u.height;
    // Shift the whole document so the union box starts at the origin.
    roots = nodes.map((node) => ({ ...node, x: (num(node.x) ?? 0) - u.x, y: (num(node.y) ?? 0) - u.y }));
  }

  const sb: string[] = [];
  sb.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}" ` +
      `viewBox="0 0 ${viewWidth} ${viewHeight}">`,
  );
  sb.push(`<rect x="0" y="0" width="${viewWidth}" height="${viewHeight}" fill="${escapeXml(opts.background)}" />`);
  const counter = { n: 0 };
  for (const root of roots) renderNode(root, opts, sb, counter);
  sb.push(`</svg>`);

  return {
    svg: sb.join(""),
    width: Math.round(viewWidth),
    height: Math.round(viewHeight),
    targetId,
    targetName,
    nodeCount: countNodes(roots),
  };
}

let resvgModule: unknown = null;
let resvgLoaded = false;

async function loadResvg(): Promise<{ Resvg: new (svg: string, opts?: unknown) => { render(): { asPng(): Uint8Array } } }> {
  if (!resvgLoaded) {
    resvgLoaded = true;
    try {
      const spec = "@resvg/resvg-js"; // non-literal import keeps it an optional runtime dep
      resvgModule = await import(spec);
    } catch {
      resvgModule = null;
    }
  }
  if (!resvgModule) {
    throw new OpenPencilRenderError(
      "@resvg/resvg-js is not installed. Run `npm install @resvg/resvg-js --save-optional` to enable openpencil_screenshot.",
    );
  }
  const mod = resvgModule as Record<string, unknown>;
  const Resvg = (mod.Resvg ?? (mod.default as Record<string, unknown> | undefined)?.Resvg) as
    | (new (svg: string, opts?: unknown) => { render(): { asPng(): Uint8Array } })
    | undefined;
  if (!Resvg) throw new OpenPencilRenderError("@resvg/resvg-js did not export a Resvg constructor.");
  return { Resvg };
}

/** Render an .op node tree (optionally cropped to one node) to a PNG buffer. */
export async function renderOpenPencilPng(nodes: RenderNode[], options: RenderPngOptions = {}): Promise<RenderPngResult> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new OpenPencilRenderError("No nodes to render.");
  }
  const built = buildSvg(nodes, options);
  const maxDimension = options.maxDimension ?? 1600;
  const longest = Math.max(built.width, built.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const { Resvg } = await loadResvg();
  const fontDirs = resolveFontDirs(options.fontDirs);
  const renderer = new Resvg(built.svg, {
    fitTo: scale === 1 ? { mode: "original" } : { mode: "zoom", value: scale },
    font: {
      ...(fontDirs.length ? { fontDirs } : {}),
      ...(options.fontFiles ? { fontFiles: options.fontFiles } : {}),
      loadSystemFonts: true,
      defaultFontFamily: "Inter",
    },
    background: options.background ?? DEFAULT_BG,
  });
  const png = Buffer.from(renderer.render().asPng());
  return {
    png,
    width: Math.round(built.width * scale),
    height: Math.round(built.height * scale),
    targetId: built.targetId,
    targetName: built.targetName,
    nodeCount: built.nodeCount,
  };
}
