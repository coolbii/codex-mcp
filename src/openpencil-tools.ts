/**
 * openpencil-tools.ts — narrow bridge to the operator-trusted OpenPencil CLI.
 *
 * This is deliberately not a general command runner. The model can choose a
 * workspace-relative .op file and provide design intent, but the binary,
 * subcommands, argv shape, cwd, env, timeout, and output cap are controlled by
 * DevSpace configuration.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type { PathGuard } from "./path-guard.js";
import type { Workspace } from "./workspaces.js";
import { renderOpenPencilPng, OpenPencilRenderError, solidColorOf, type RenderNode } from "./openpencil-render.js";

const MAX_PROMPT_BYTES = 200_000;
const MAX_JSON_BYTES = 500_000;
const MAX_OPENPENCIL_OUTPUT_BYTES = 200_000;

export class OpenPencilError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenPencilError";
  }
}

export interface OpenPencilRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OpenPencilStatusResult extends OpenPencilRunResult {
  enabled: boolean;
}

export interface OpenPencilLintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
  nodeName?: string;
  fix?: string;
}

export interface OpenPencilLintSummary {
  ok: boolean;
  checkedFrames: number;
  visibleElementNodes: number;
  visibleTextNodes: number;
  issues: OpenPencilLintIssue[];
}

export interface OpenPencilLintResult extends OpenPencilRunResult, OpenPencilLintSummary {}

interface OpenPencilNode {
  id?: string;
  type?: string;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: unknown;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number;
  content?: string;
  children?: OpenPencilNode[] | string;
}

function killTree(child: ChildProcess): void {
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    /* already gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

function appendLog(current: string, chunk: Buffer, cap: number): string {
  const next = current + chunk.toString("utf8");
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function safeTimeout(config: AppConfig, timeoutMs?: number): number {
  const chosen = timeoutMs ?? config.shellTimeoutMs;
  if (!Number.isInteger(chosen) || chosen < 1_000 || chosen > 300_000) {
    throw new OpenPencilError("timeoutMs must be between 1000 and 300000");
  }
  return chosen;
}

function assertEnabled(config: AppConfig): void {
  if (!config.enableOpenPencil) {
    throw new OpenPencilError("OpenPencil bridge is disabled (set ENABLE_OPENPENCIL=1 to enable).");
  }
}

function assertOpPath(path: string): string {
  if (!path.toLowerCase().endsWith(".op")) {
    throw new OpenPencilError("OpenPencil file path must end with .op");
  }
  if (isAbsolute(path)) {
    throw new OpenPencilError("OpenPencil file path must be workspace-relative");
  }
  const segments = path.split(/[\\/]/);
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg === ".git" || /[\x00-\x1f]/.test(seg)) {
      throw new OpenPencilError("Invalid OpenPencil file path segment");
    }
  }
  const leaf = basename(path);
  if (!leaf || leaf === ".op" || /[\x00-\x1f]/.test(leaf)) {
    throw new OpenPencilError("Invalid OpenPencil file path");
  }
  return path.replace(/\\/g, "/");
}

function runOpenPencil(
  config: AppConfig,
  cwd: string,
  args: string[],
  input: string | undefined,
  timeoutMs?: number,
): Promise<OpenPencilRunResult> {
  assertEnabled(config);
  const startedAt = Date.now();
  const cap = Math.min(config.shellMaxOutputBytes, MAX_OPENPENCIL_OUTPUT_BYTES);
  const timeout = safeTimeout(config, timeoutMs);
  return new Promise((resolveRun, reject) => {
    const child = spawn(config.openPencilCli, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv(),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLog(stdout, chunk, cap);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLog(stderr, chunk, cap);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new OpenPencilError(`Failed to start OpenPencil CLI: ${err.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveRun({
        command: config.openPencilCli,
        args,
        cwd,
        exitCode,
        signal,
        timedOut,
        truncated: stdout.length >= cap || stderr.length >= cap,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

function runMacOpen(
  config: AppConfig,
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<OpenPencilRunResult> {
  assertEnabled(config);
  if (process.platform !== "darwin") {
    throw new OpenPencilError("Native OpenPencil app open fallback is only available on macOS");
  }
  const startedAt = Date.now();
  const cap = Math.min(config.shellMaxOutputBytes, MAX_OPENPENCIL_OUTPUT_BYTES);
  const timeout = safeTimeout(config, timeoutMs);
  return new Promise((resolveRun, reject) => {
    const command = "/usr/bin/open";
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendLog(stdout, chunk, cap);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendLog(stderr, chunk, cap);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new OpenPencilError(`Failed to open OpenPencil app: ${err.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveRun({
        command,
        args,
        cwd,
        exitCode,
        signal,
        timedOut,
        truncated: stdout.length >= cap || stderr.length >= cap,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function resolveOpWrite(guard: PathGuard, ws: Workspace, path: string): Promise<string> {
  const rel = assertOpPath(path);
  await ensureParentDirs(guard, ws, dirname(rel));
  const target = await guard.resolveForWrite(ws.root, rel);
  await mkdir(dirname(target), { recursive: true });
  return target;
}

async function resolveOpRead(guard: PathGuard, ws: Workspace, path: string): Promise<string> {
  return guard.resolveForRead(ws.root, assertOpPath(path));
}

async function ensureParentDirs(guard: PathGuard, ws: Workspace, parent: string): Promise<void> {
  if (!parent || parent === ".") return;
  let current = "";
  for (const segment of parent.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const existing = await guard.resolveForRead(ws.root, current).catch(() => null);
    if (existing) {
      const st = await stat(existing);
      if (!st.isDirectory()) throw new OpenPencilError(`OpenPencil parent path is not a directory: ${current}`);
      continue;
    }
    const target = await guard.resolveForWrite(ws.root, current);
    await mkdir(target, { recursive: false }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }
}

function checkedPrompt(prompt: string): string {
  if (typeof prompt !== "string" || !prompt.trim()) throw new OpenPencilError("prompt is required");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new OpenPencilError("prompt is too large");
  }
  return prompt;
}

function checkedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new OpenPencilError("JSON value is required");
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
    throw new OpenPencilError("JSON value is too large");
  }
  return json;
}

function checkedId(id: string, field = "id"): string {
  if (typeof id !== "string" || !id.trim()) throw new OpenPencilError(`${field} is required`);
  if (id.length > 200 || /[\x00-\x1f]/.test(id)) throw new OpenPencilError(`Invalid ${field}`);
  return id;
}

function checkedIds(ids: readonly string[] | undefined): string | undefined {
  if (!ids?.length) return undefined;
  if (ids.length > 200) throw new OpenPencilError("Too many node ids");
  return ids.map((id) => checkedId(id)).join(",");
}

function nodeChildren(node: OpenPencilNode): OpenPencilNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function nodeLabel(node: OpenPencilNode): string {
  return node.name || node.id || node.type || "(unnamed)";
}

function isGenericLayerName(name: string | undefined): boolean {
  return /^(rectangle|rect|text|frame|group|layer)\s*\d*$/i.test((name ?? "").trim());
}

function isFullFrameBackground(parent: OpenPencilNode, child: OpenPencilNode): boolean {
  const name = (child.name ?? "").toLowerCase();
  const bgName = /background|foundation|surface-base|surface base|bg/.test(name);
  if (!bgName) return false;
  if (typeof parent.width !== "number" || typeof parent.height !== "number") return false;
  if (typeof child.width !== "number" || typeof child.height !== "number") return false;
  const x = child.x ?? 0;
  const y = child.y ?? 0;
  return (
    Math.abs(x) <= 2 &&
    Math.abs(y) <= 2 &&
    child.width >= parent.width * 0.95 &&
    child.height >= parent.height * 0.95
  );
}

function pushIssue(issues: OpenPencilLintIssue[], issue: OpenPencilLintIssue): void {
  issues.push(issue);
}

function estimateTextWidth(content: string, fontSize: number): number {
  return content.length * fontSize * 0.55;
}

const SECTION_BANNER_RE = /^Section \/ (\d{2})\b/;
const SCREEN_RE = /^Screen \//;
const MATRIX_CELL_RE = /^Matrix Cell \//;
const STATE_MATRIX_RE = /(state matrix|section \/ 06)/i;

function nodeNameTrim(node: OpenPencilNode): string {
  return (node.name ?? "").trim();
}

/** A "Banner BG" fill must be a saturated color; missing or near-white reads as ungrouped. */
function isNearWhiteOrMissing(fill: unknown): boolean {
  if (fill == null) return true;
  if (typeof fill === "string" && !fill.trim()) return true;
  if (Array.isArray(fill) && fill.length === 0) return true;
  const color = solidColorOf(fill);
  if (!color) return false; // gradient/image paint — assume an intentional color
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false; // rgb()/named — assume an intentional color
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return Math.min(r, g, b) >= 230;
}

function anyDescendant(node: OpenPencilNode, predicate: (n: OpenPencilNode) => boolean): boolean {
  for (const child of nodeChildren(node)) {
    if (predicate(child) || anyDescendant(child, predicate)) return true;
  }
  return false;
}

/**
 * Canvas-level rules that the per-node visit cannot express: a package must group its
 * frames under visible colored "Section / NN" banners, and a state matrix must fill
 * every cell. These make "organized like a polished design file" lint-enforceable
 * instead of a vibe.
 */
function scanCanvasOrganization(nodes: OpenPencilNode[], issues: OpenPencilLintIssue[]): void {
  let screenCount = 0;
  const banners: OpenPencilNode[] = [];
  const matrixCells: OpenPencilNode[] = [];
  let stateMatrixBand: OpenPencilNode | null = null;

  const walk = (node: OpenPencilNode): void => {
    const name = nodeNameTrim(node);
    if (SCREEN_RE.test(name)) screenCount++;
    if (SECTION_BANNER_RE.test(name)) banners.push(node);
    if (MATRIX_CELL_RE.test(name)) matrixCells.push(node);
    if (!stateMatrixBand && node.type === "frame" && STATE_MATRIX_RE.test(name)) stateMatrixBand = node;
    for (const child of nodeChildren(node)) walk(child);
  };
  for (const node of nodes) walk(node);

  const topFrames = nodes.filter((node) => node.type === "frame").length;
  const isPackage = screenCount >= 2 || topFrames > 3;

  if (isPackage && banners.length < 3) {
    pushIssue(issues, {
      severity: "error",
      code: "missing-section-banners",
      message: `Canvas looks like a multi-section design package (${screenCount} screen frame(s), ${topFrames} top-level frame(s)) but has only ${banners.length} "Section / NN <Title>" banner(s); group frames under visible colored section bars (00 Brief … 10 Handoff).`,
      fix: 'Wrap each phase in a frame named "Section / NN <Title>" (e.g. "Section / 04 Foundations") containing a full-width colored "Banner BG" rectangle as the last child, plus "Index Chip"+"Index Number", a white "Section Title", and a "Section Subtitle". Stack the bands top-to-bottom.',
    });
  }

  for (const banner of banners) {
    const kids = nodeChildren(banner);
    const kidNames = kids.map((child) => nodeNameTrim(child));
    const missing: string[] = [];
    if (!kidNames.some((name) => /^banner bg$/i.test(name))) missing.push("Banner BG");
    if (!kidNames.some((name) => /^section title$/i.test(name))) missing.push("Section Title");
    if (missing.length) {
      pushIssue(issues, {
        severity: "warning",
        code: "incomplete-section-banner",
        message: `Section banner "${nodeLabel(banner)}" is missing required chrome: ${missing.join(", ")}.`,
        ...(banner.id ? { nodeId: banner.id } : {}),
        ...(banner.name ? { nodeName: banner.name } : {}),
        fix: 'A banner needs at least a full-width colored "Banner BG" rectangle (last child) and a white "Section Title" text. Add "Index Chip"/"Index Number" and a "Section Subtitle" so it reads like a section header.',
      });
      continue;
    }
    const bg = kids.find((child) => /^banner bg$/i.test(nodeNameTrim(child)));
    if (bg && isNearWhiteOrMissing(bg.fill)) {
      pushIssue(issues, {
        severity: "warning",
        code: "incomplete-section-banner",
        message: `Section banner "${nodeLabel(banner)}" has a "Banner BG" with no saturated color; section bars must be visibly colored to group frames.`,
        ...(bg.id ? { nodeId: bg.id } : {}),
        ...(bg.name ? { nodeName: bg.name } : {}),
        fix: 'Set the "Banner BG" fill to the band category color, e.g. 04 Foundations teal #0F766E, 06 State Matrix amber #B45309, 07 Screens rose #BE123C.',
      });
    }
  }

  if (stateMatrixBand) {
    const band: OpenPencilNode = stateMatrixBand;
    const hasHeaderRow = anyDescendant(band, (node) => /^matrix \/ header row$/i.test(nodeNameTrim(node)));
    if (!hasHeaderRow) {
      pushIssue(issues, {
        severity: "warning",
        code: "missing-state-matrix-headers",
        message: `State matrix "${nodeLabel(band)}" has no "Matrix / Header Row".`,
        ...(band.id ? { nodeId: band.id } : {}),
        ...(band.name ? { nodeName: band.name } : {}),
        fix: 'Add a "Matrix / Header Row" with one text header per state column: Default, Hover, Focus, Active, Selected, Disabled, Loading, Empty, Error, Success.',
      });
    }
  }

  for (const cell of matrixCells) {
    if (nodeChildren(cell).length === 0) {
      pushIssue(issues, {
        severity: "error",
        code: "empty-state-cell",
        message: `State-matrix cell "${nodeLabel(cell)}" is empty; every component/state intersection must show a variant or an explicit "n/a — reason".`,
        ...(cell.id ? { nodeId: cell.id } : {}),
        ...(cell.name ? { nodeName: cell.name } : {}),
        fix: 'Insert the component variant for this state, or a text "n/a — <why this state is out of scope>". Do not leave matrix cells blank.',
      });
    }
  }
}

export function lintOpenPencilNodeTree(nodes: OpenPencilNode[]): OpenPencilLintSummary {
  const issues: OpenPencilLintIssue[] = [];
  let checkedFrames = 0;
  let visibleElementNodes = 0;
  let visibleTextNodes = 0;

  const visit = (node: OpenPencilNode, parent: OpenPencilNode | null): void => {
    if (node.type === "text") {
      visibleTextNodes++;
      if (!node.fontFamily?.trim()) {
        pushIssue(issues, {
          severity: "error",
          code: "missing-font-family",
          message: `Text layer "${nodeLabel(node)}" has no explicit fontFamily; remote CanvasKit previews can render missing glyph boxes when relying on system fallback.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: 'Set a bundled UI font such as {"fontFamily":"Inter","fontWeight":400}. Use "Noto Sans SC" for Chinese text.',
        });
      }
      if (typeof node.fontSize === "number" && node.fontSize < 11) {
        pushIssue(issues, {
          severity: "warning",
          code: "tiny-text",
          message: `Text layer "${nodeLabel(node)}" uses fontSize ${node.fontSize}; product UI text should usually be 11px or larger.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: "Increase fontSize or convert it to a non-text decorative mark.",
        });
      }
      if (!node.content?.trim()) {
        pushIssue(issues, {
          severity: "warning",
          code: "empty-text",
          message: `Text layer "${nodeLabel(node)}" has no readable content.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: "Add real domain copy or remove the placeholder layer.",
        });
      }
      if (
        typeof node.width === "number" &&
        typeof node.fontSize === "number" &&
        node.width > 0 &&
        node.content &&
        !node.content.includes("\n") &&
        estimateTextWidth(node.content, node.fontSize) > node.width * 1.15
      ) {
        pushIssue(issues, {
          severity: "warning",
          code: "likely-text-overflow",
          message: `Text layer "${nodeLabel(node)}" is likely wider than its box (${node.width}px), which can overlap adjacent components.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: "Increase width, reduce fontSize, or insert deliberate line breaks with enough height/lineHeight.",
        });
      }
    } else if (node.type) {
      visibleElementNodes++;
    }

    if (isGenericLayerName(node.name)) {
      pushIssue(issues, {
        severity: "warning",
        code: "generic-layer-name",
        message: `Layer "${node.name}" is not semantically named.`,
        ...(node.id ? { nodeId: node.id } : {}),
        ...(node.name ? { nodeName: node.name } : {}),
        fix: "Rename by role, for example Header, Email Field, Primary Action Button, or Metric Card.",
      });
    }

    const children = nodeChildren(node);
    if (node.type === "frame") {
      checkedFrames++;
      if (children.length === 0) {
        pushIssue(issues, {
          severity: "error",
          code: "empty-frame",
          message: `Frame "${nodeLabel(node)}" has no child layers.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: "Insert visible layout/content/component children before saving or previewing.",
        });
      }

      const hasNamedOrganization = children.some((child) =>
        /^(foundations?|components?|layout|content|states?)\s*\//i.test(child.name ?? ""),
      );
      const isScreenLike = typeof node.width === "number" && node.width >= 900 && typeof node.height === "number" && node.height >= 600;
      if (isScreenLike && children.length > 2 && !hasNamedOrganization) {
        pushIssue(issues, {
          severity: "warning",
          code: "missing-component-organization",
          message: `Screen frame "${nodeLabel(node)}" does not expose Foundations/Components/Layout/Content/States organization in its immediate children.`,
          ...(node.id ? { nodeId: node.id } : {}),
          ...(node.name ? { nodeName: node.name } : {}),
          fix: "Group or name top-level sections with semantic prefixes such as Layout / Header, Component / Login Card, Content / Hero.",
        });
      }

      children.forEach((child, index) => {
        if (isFullFrameBackground(node, child) && index !== children.length - 1) {
          pushIssue(issues, {
            severity: "error",
            code: "background-z-order",
            message: `Full-frame background "${nodeLabel(child)}" is child ${index + 1}/${children.length}; in the current OpenPencil renderer it can cover later UI layers unless it is the last child.`,
            ...(child.id ? { nodeId: child.id } : {}),
            ...(child.name ? { nodeName: child.name } : {}),
            fix: child.id && node.id ? `Run openpencil_move with id "${child.id}", parent "${node.id}", index 999.` : "Move the background layer to the last child of its parent frame.",
          });
        }
      });
    }

    for (const child of children) visit(child, node);
    if (parent) {
      // Keep parent in the signature so future lint rules can compare siblings.
    }
  };

  for (const node of nodes) visit(node, null);
  scanCanvasOrganization(nodes, issues);

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    checkedFrames,
    visibleElementNodes,
    visibleTextNodes,
    issues,
  };
}

export interface OpenPencilScreenshotResult {
  targetId: string | null;
  targetName: string | null;
  width: number;
  height: number;
  pngBase64: string;
  byteLength: number;
  nodeCount: number;
}

/**
 * Render the live canvas or a guarded .op file (optionally one node) to a PNG so an
 * AI client can SEE what it authored and judge visual quality. Reads nodes through
 * the guarded read-nodes path, then rasterizes via the approximate SVG renderer.
 */
function parseNodeTree(stdout: string): OpenPencilNode[] {
  let parsed: { nodes?: OpenPencilNode[] };
  try {
    parsed = JSON.parse(stdout) as { nodes?: OpenPencilNode[] };
  } catch {
    throw new OpenPencilError("OpenPencil returned invalid JSON");
  }
  return Array.isArray(parsed.nodes) ? parsed.nodes : [];
}

/**
 * Read the node tree for lint/screenshot, robust to an OpenPencil CLI quirk:
 * `op read-nodes --file` is sensitive to the file's JSON formatting and can
 * silently return [] for a valid .op that `op get` reads fine (e.g. a file
 * written by write_file or `op design` with pretty-printed JSON). When
 * read-nodes yields no nodes, fall back to the lenient `op get`. Returns the
 * nodes plus the run whose exit status callers report.
 */
async function readNodeTreeWithFallback(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: { path?: string; ids?: readonly string[]; page?: string; timeoutMs?: number },
): Promise<{ nodes: OpenPencilNode[]; run: OpenPencilRunResult }> {
  const read = await openPencilReadNodes(config, guard, ws, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.ids !== undefined ? { ids: [...input.ids] } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    depth: 50,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (read.exitCode !== 0) return { nodes: [], run: read };
  const nodes = parseNodeTree(read.stdout);
  if (nodes.length > 0) return { nodes, run: read };
  const got = await openPencilGet(config, guard, ws, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (got.exitCode === 0) {
    const gotNodes = parseNodeTree(got.stdout);
    if (gotNodes.length > 0) return { nodes: gotNodes, run: got };
  }
  return { nodes, run: read };
}

export async function openPencilScreenshot(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    path?: string;
    id?: string;
    page?: string;
    maxDimension?: number;
    background?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilScreenshotResult> {
  if (
    input.maxDimension !== undefined &&
    (!Number.isInteger(input.maxDimension) || input.maxDimension < 64 || input.maxDimension > 4096)
  ) {
    throw new OpenPencilError("maxDimension must be between 64 and 4096");
  }
  const { nodes, run } = await readNodeTreeWithFallback(config, guard, ws, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.id !== undefined ? { ids: [input.id] } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (run.exitCode !== 0) {
    throw new OpenPencilError(
      `OpenPencil read failed (exit ${run.exitCode}): ${(run.stderr || run.stdout || "").trim()}`,
    );
  }
  if (nodes.length === 0) throw new OpenPencilError("No OpenPencil nodes to screenshot.");
  try {
    const rendered = await renderOpenPencilPng(nodes as unknown as RenderNode[], {
      ...(input.id !== undefined ? { targetId: input.id } : {}),
      ...(input.maxDimension !== undefined ? { maxDimension: input.maxDimension } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
    });
    return {
      targetId: rendered.targetId,
      targetName: rendered.targetName,
      width: rendered.width,
      height: rendered.height,
      pngBase64: rendered.png.toString("base64"),
      byteLength: rendered.png.length,
      nodeCount: rendered.nodeCount,
    };
  } catch (err) {
    if (err instanceof OpenPencilRenderError) throw new OpenPencilError(err.message);
    throw err;
  }
}

async function appendOptionalFileArg(
  args: string[],
  guard: PathGuard,
  ws: Workspace,
  path: string | undefined,
  mode: "read" | "write" = "read",
): Promise<void> {
  if (!path) return;
  const target = mode === "write" ? await resolveOpWrite(guard, ws, path) : await resolveOpRead(guard, ws, path);
  args.push("--file", target);
}

export async function openPencilStatus(config: AppConfig, ws: Workspace, timeoutMs?: number): Promise<OpenPencilStatusResult> {
  const result = await runOpenPencil(config, ws.root, ["status"], undefined, timeoutMs);
  return { ...result, enabled: config.enableOpenPencil };
}

export async function openPencilStart(config: AppConfig, ws: Workspace, timeoutMs?: number): Promise<OpenPencilRunResult> {
  try {
    const result = await runOpenPencil(config, ws.root, ["start"], undefined, timeoutMs);
    if (result.exitCode === 0) return result;
    if (process.platform !== "darwin") return result;
  } catch (err) {
    if (process.platform !== "darwin") throw err;
  }
  return runMacOpen(config, ws.root, ["-a", "OpenPencil"], timeoutMs);
}

export async function openPencilOpen(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  path: string,
  timeoutMs?: number,
): Promise<OpenPencilRunResult> {
  const target = await resolveOpRead(guard, ws, path);
  try {
    const result = await runOpenPencil(config, ws.root, ["open", target], undefined, timeoutMs);
    if (result.exitCode === 0) return result;
    if (process.platform !== "darwin") return result;
  } catch (err) {
    if (process.platform !== "darwin") throw err;
  }
  return runMacOpen(config, ws.root, ["-a", "OpenPencil", target], timeoutMs);
}

export async function openPencilSave(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  path: string,
  timeoutMs?: number,
): Promise<OpenPencilRunResult> {
  const target = await resolveOpWrite(guard, ws, path);
  return runOpenPencil(config, ws.root, ["save", target], undefined, timeoutMs);
}

export async function openPencilDesign(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    path: string;
    prompt: string;
    canvasWidth?: number;
    postProcess?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const target = await resolveOpWrite(guard, ws, input.path);
  const prompt = checkedPrompt(input.prompt);
  const args = ["design", "-", "--file", target];
  if (input.canvasWidth !== undefined) {
    if (!Number.isInteger(input.canvasWidth) || input.canvasWidth < 320 || input.canvasWidth > 7680) {
      throw new OpenPencilError("canvasWidth must be between 320 and 7680");
    }
    args.push("--canvas-width", String(input.canvasWidth));
  }
  if (input.postProcess) args.push("--post-process");
  return runOpenPencil(config, ws.root, args, prompt, input.timeoutMs);
}

export async function openPencilGet(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    path?: string;
    query?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["get"];
  if (input.query?.trim()) args.push(input.query.trim());
  if (input.path) args.push("--file", await resolveOpRead(guard, ws, input.path));
  return runOpenPencil(config, ws.root, args, undefined, input.timeoutMs);
}

export async function openPencilReadNodes(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    path?: string;
    ids?: string[];
    depth?: number;
    vars?: boolean;
    page?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["read-nodes"];
  const ids = checkedIds(input.ids);
  if (ids) args.push(ids);
  if (input.depth !== undefined) {
    if (!Number.isInteger(input.depth) || input.depth < 0 || input.depth > 50) {
      throw new OpenPencilError("depth must be between 0 and 50");
    }
    args.push("--depth", String(input.depth));
  }
  if (input.vars) args.push("--vars");
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, undefined, input.timeoutMs);
}

export async function openPencilLintDesign(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    path?: string;
    ids?: string[];
    page?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilLintResult> {
  const { nodes, run } = await readNodeTreeWithFallback(config, guard, ws, {
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.ids !== undefined ? { ids: input.ids } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (run.exitCode !== 0) {
    return { ...run, ok: false, checkedFrames: 0, visibleElementNodes: 0, visibleTextNodes: 0, issues: [] };
  }
  const summary = lintOpenPencilNodeTree(nodes);
  return { ...run, ...summary };
}

export async function openPencilSelection(
  config: AppConfig,
  ws: Workspace,
  timeoutMs?: number,
): Promise<OpenPencilRunResult> {
  return runOpenPencil(config, ws.root, ["selection"], undefined, timeoutMs);
}

export async function openPencilInsert(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    node: unknown;
    path?: string;
    parent?: string;
    index?: number;
    page?: string;
    postProcess?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["insert", "-"];
  if (input.parent !== undefined) args.push("--parent", checkedId(input.parent, "parent"));
  if (input.index !== undefined) {
    if (!Number.isInteger(input.index) || input.index < 0 || input.index > 100_000) {
      throw new OpenPencilError("index must be a non-negative integer");
    }
    args.push("--index", String(input.index));
  }
  if (input.postProcess) args.push("--post-process");
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, checkedJson(input.node), input.timeoutMs);
}

export async function openPencilUpdate(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    id: string;
    patch: unknown;
    path?: string;
    page?: string;
    postProcess?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["update", checkedId(input.id), "-"];
  if (input.postProcess) args.push("--post-process");
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, checkedJson(input.patch), input.timeoutMs);
}

export async function openPencilReplace(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    id: string;
    node: unknown;
    path?: string;
    page?: string;
    postProcess?: boolean;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["replace", checkedId(input.id), "-"];
  if (input.postProcess) args.push("--post-process");
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, checkedJson(input.node), input.timeoutMs);
}

export async function openPencilMove(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    id: string;
    parent: string;
    index?: number;
    path?: string;
    page?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["move", checkedId(input.id), "--parent", checkedId(input.parent, "parent")];
  if (input.index !== undefined) {
    if (!Number.isInteger(input.index) || input.index < 0 || input.index > 100_000) {
      throw new OpenPencilError("index must be a non-negative integer");
    }
    args.push("--index", String(input.index));
  }
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, undefined, input.timeoutMs);
}

export async function openPencilDelete(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: {
    id: string;
    path?: string;
    page?: string;
    timeoutMs?: number;
  },
): Promise<OpenPencilRunResult> {
  const args = ["delete", checkedId(input.id)];
  if (input.page !== undefined) args.push("--page", checkedId(input.page, "page"));
  await appendOptionalFileArg(args, guard, ws, input.path);
  return runOpenPencil(config, ws.root, args, undefined, input.timeoutMs);
}

// --- Section-band helper -----------------------------------------------------
// `op insert` rejects string fills and `op insert --file` does not persist to
// the file (it targets the live app), which is why models fall back to raw
// write_file. This helper authors a lint-clean, correctly-colored section band
// directly into the .op file as canonical op JSON (array fills, Banner BG as the
// last child for OpenPencil's reverse z-order), removing the coordinate/most-
// common-mistake burden that makes hand-built packages fail.

interface OpenPencilPaint {
  type: "solid";
  color: string;
}

/** Banner / chip / accent colors per harness section index (00 Brief … 10 Handoff). */
const SECTION_PALETTE: Record<string, { banner: string; chip: string; accent: string }> = {
  "00": { banner: "#1F2937", chip: "#111827", accent: "#374151" },
  "01": { banner: "#5B21B6", chip: "#4C1D95", accent: "#7C3AED" },
  "02": { banner: "#3730A3", chip: "#312E81", accent: "#4F46E5" },
  "03": { banner: "#1D4ED8", chip: "#1E3A8A", accent: "#3B82F6" },
  "04": { banner: "#0F766E", chip: "#115E59", accent: "#5EEAD4" },
  "05": { banner: "#15803D", chip: "#166534", accent: "#4ADE80" },
  "06": { banner: "#B45309", chip: "#92400E", accent: "#FBBF24" },
  "07": { banner: "#BE123C", chip: "#9F1239", accent: "#FB7185" },
  "08": { banner: "#A21CAF", chip: "#86198F", accent: "#E879F9" },
  "09": { banner: "#C2410C", chip: "#9A3412", accent: "#FB923C" },
  "10": { banner: "#0E7490", chip: "#155E75", accent: "#22D3EE" },
};
const SECTION_PALETTE_DEFAULT = { banner: "#1F2937", chip: "#111827", accent: "#374151" };

function paint(color: string): OpenPencilPaint[] {
  return [{ type: "solid", color }];
}

export interface SectionBandInput {
  index: string;
  title: string;
  subtitle?: string;
  color?: string;
  chipColor?: string;
  accentColor?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/**
 * Build a lint-clean `Section / NN <Title>` band node (Divider Tab, Index Chip,
 * Index Number, Section Title, optional Section Subtitle, and a full-width colored
 * Banner BG as the LAST child). Pure and deterministic except the random node id.
 */
export function buildSectionBand(input: SectionBandInput): OpenPencilNode {
  const idx = String(input.index).trim().padStart(2, "0");
  const pal = SECTION_PALETTE[idx] ?? SECTION_PALETTE_DEFAULT;
  const banner = input.color ?? pal.banner;
  const chip = input.chipColor ?? pal.chip;
  const accent = input.accentColor ?? pal.accent;
  const x = input.x ?? 0;
  const y = input.y ?? 0;
  const width = input.width ?? 1200;
  const height = input.height ?? 96;
  const id = `sec-${idx}-${randomBytes(4).toString("hex")}`;
  const textWidth = Math.max(200, width - 300);
  const children: OpenPencilNode[] = [
    { id: `${id}-tab`, type: "rectangle", name: "Divider Tab", x: 0, y: 0, width: 6, height, fill: paint(accent) },
    { id: `${id}-chip`, type: "rectangle", name: "Index Chip", x: 40, y: Math.round(height * 0.21), width: 88, height: Math.round(height * 0.58), fill: paint(chip) },
    { id: `${id}-num`, type: "text", name: "Index Number", x: 40, y: Math.round(height * 0.33), width: 88, height: 36, fill: paint("#FFFFFF"), fontFamily: "Inter", fontWeight: 700, fontSize: 28, content: idx },
    { id: `${id}-title`, type: "text", name: "Section Title", x: 152, y: Math.round(height * 0.23), width: textWidth, height: 42, fill: paint("#FFFFFF"), fontFamily: "Inter", fontWeight: 700, fontSize: 34, content: input.title },
  ];
  if (input.subtitle?.trim()) {
    children.push({ id: `${id}-sub`, type: "text", name: "Section Subtitle", x: 152, y: Math.round(height * 0.66), width: textWidth, height: 22, fill: paint("#E5E7EB"), fontFamily: "Inter", fontWeight: 400, fontSize: 16, content: input.subtitle });
  }
  // Banner BG MUST be the last child (OpenPencil paints the last child at the back).
  children.push({ id: `${id}-bg`, type: "rectangle", name: "Banner BG", x: 0, y: 0, width, height, fill: paint(banner) });
  return { id, type: "frame", name: `Section / ${idx} ${input.title}`, x, y, width, height, fill: paint("#F8FAFC"), children };
}

interface OpDocument {
  version?: string;
  name?: string;
  pages?: Array<{ id?: string; name?: string; children?: OpenPencilNode[] }>;
  children?: OpenPencilNode[];
}

export interface OpenPencilSectionBandResult {
  nodeId: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  bandCount: number;
}

/**
 * Author a section band directly into a guarded .op file (read-modify-write), so
 * it is reliable (unlike `op insert --file`) and lint-clean. Auto-stacks below
 * existing `Section /` bands on the rail unless an explicit `y` is given.
 */
export async function openPencilInsertSectionBand(
  config: AppConfig,
  guard: PathGuard,
  ws: Workspace,
  input: SectionBandInput & { path: string; page?: string },
): Promise<OpenPencilSectionBandResult> {
  assertEnabled(config);
  if (typeof input.title !== "string" || !input.title.trim()) throw new OpenPencilError("title is required");
  if (input.title.length > 200) throw new OpenPencilError("title is too long");
  if (input.subtitle !== undefined && input.subtitle.length > 400) throw new OpenPencilError("subtitle is too long");
  if (!/^\d{1,2}$/.test(String(input.index).trim())) throw new OpenPencilError('index must be 1-2 digits, e.g. "04"');
  for (const c of [input.color, input.chipColor, input.accentColor]) {
    if (c !== undefined && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) throw new OpenPencilError("colors must be hex, e.g. #0F766E");
  }
  const target = await resolveOpWrite(guard, ws, input.path);

  let doc: OpDocument | null = null;
  try {
    doc = JSON.parse(await readFile(target, "utf8")) as OpDocument;
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== "object") {
    doc = { version: "1.0.0", name: basename(input.path).replace(/\.op$/i, ""), pages: [{ id: "p", name: "Page 1", children: [] }], children: [] };
  }
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) doc.pages = [{ id: "p", name: "Page 1", children: [] }];
  const page = (input.page ? doc.pages.find((p) => p.id === input.page) : undefined) ?? doc.pages[0]!;
  if (!Array.isArray(page.children)) page.children = [];

  const BAND_GAP = 160;
  let y = input.y;
  if (y === undefined) {
    let maxBottom = -Infinity;
    for (const child of page.children) {
      if (typeof child?.name === "string" && /^Section \//.test(child.name)) {
        maxBottom = Math.max(maxBottom, (child.y ?? 0) + (child.height ?? 96));
      }
    }
    y = Number.isFinite(maxBottom) ? maxBottom + BAND_GAP : 0;
  }

  const node = buildSectionBand({ ...input, y });
  page.children.push(node);
  await writeFile(target, JSON.stringify(doc), "utf8");

  const bandCount = page.children.filter((c) => typeof c?.name === "string" && /^Section \//.test(c.name)).length;
  return {
    nodeId: node.id!,
    name: node.name!,
    x: node.x ?? 0,
    y,
    width: node.width ?? 1200,
    height: node.height ?? 96,
    color: input.color ?? (SECTION_PALETTE[String(input.index).trim().padStart(2, "0")] ?? SECTION_PALETTE_DEFAULT).banner,
    bandCount,
  };
}
