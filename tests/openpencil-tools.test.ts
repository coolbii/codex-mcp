import { afterEach, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { PathGuard } from "../src/path-guard.js";
import { makeApp } from "../src/http.js";
import { OpenPencilPreviewManager } from "../src/openpencil-preview-tools.js";
import {
  openPencilDelete,
  openPencilDesign,
  openPencilInsert,
  lintOpenPencilNodeTree,
  openPencilMove,
  openPencilOpen,
  openPencilLintDesign,
  openPencilReadNodes,
  openPencilReplace,
  openPencilSave,
  openPencilScreenshot,
  openPencilSelection,
  openPencilStatus,
  openPencilUpdate,
  OpenPencilError,
} from "../src/openpencil-tools.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
  await fx?.cleanup();
});

const silent = (): void => {};

it("lints full-frame backgrounds that would cover visible content", () => {
  const bad = lintOpenPencilNodeTree([
    {
      id: "screen",
      type: "frame",
      name: "Screen / Login",
      width: 1440,
      height: 1120,
      children: [
        {
          id: "bg",
          type: "rectangle",
          name: "Foundation / surface-base",
          x: 0,
          y: 0,
          width: 1440,
          height: 1120,
        },
        { id: "card", type: "frame", name: "Component / Login Card", x: 800, y: 120, width: 420, height: 640 },
      ],
    },
  ]);

  expect(bad.ok).toBe(false);
  expect(bad.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "background-z-order",
        nodeId: "bg",
      }),
    ]),
  );

  const good = lintOpenPencilNodeTree([
    {
      id: "screen",
      type: "frame",
      name: "Screen / Login",
      width: 1440,
      height: 1120,
      children: [
        { id: "card", type: "frame", name: "Component / Login Card", x: 800, y: 120, width: 420, height: 640 },
        {
          id: "bg",
          type: "rectangle",
          name: "Foundation / surface-base",
          x: 0,
          y: 0,
          width: 1440,
          height: 1120,
        },
      ],
    },
  ]);

  expect(good.issues.find((issue) => issue.code === "background-z-order")).toBeUndefined();
});

it("lints text that relies on font fallback or likely overflows its box", () => {
  const summary = lintOpenPencilNodeTree([
    {
      id: "screen",
      type: "frame",
      name: "Screen / Login",
      width: 1440,
      height: 900,
      children: [
        {
          id: "headline",
          type: "text",
          name: "Content / Hero Headline",
          content: "Return to your revenue command center.",
          x: 96,
          y: 168,
          width: 360,
          height: 52,
          fontSize: 42,
        },
      ],
    },
  ]);

  expect(summary.ok).toBe(false);
  expect(summary.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "missing-font-family",
        nodeId: "headline",
      }),
      expect.objectContaining({
        severity: "warning",
        code: "likely-text-overflow",
        nodeId: "headline",
      }),
    ]),
  );
});

it("requires colored Section/NN banners once the canvas is a multi-section package", () => {
  const bannerless = lintOpenPencilNodeTree([
    { id: "s1", type: "frame", name: "Screen / Dashboard / Desktop", width: 1440, height: 900, children: [{ id: "c1", type: "frame", name: "Content / Body", x: 0, y: 0, width: 100, height: 100 }] },
    { id: "s2", type: "frame", name: "Screen / Detail / Desktop", width: 1440, height: 900, children: [{ id: "c2", type: "frame", name: "Content / Body", x: 0, y: 0, width: 100, height: 100 }] },
  ]);
  expect(bannerless.ok).toBe(false);
  expect(bannerless.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ severity: "error", code: "missing-section-banners" })]),
  );

  const banner = (n: string, idx: string, fill: string) => ({
    id: `sec-${idx}`,
    type: "frame" as const,
    name: `Section / ${idx} ${n}`,
    x: 0,
    y: 0,
    width: 1200,
    height: 96,
    children: [
      { id: `t-${idx}`, type: "text", name: "Section Title", x: 150, y: 20, width: 400, height: 42, fill: "#FFFFFF", fontFamily: "Inter", fontWeight: 700, fontSize: 34, content: n },
      { id: `bg-${idx}`, type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill },
    ],
  });
  const organized = lintOpenPencilNodeTree([
    banner("Brief", "00", "#1F2937"),
    banner("Foundations", "04", "#0F766E"),
    banner("Screens", "07", "#BE123C"),
    { id: "s1", type: "frame", name: "Screen / Dashboard / Desktop", width: 1440, height: 900, children: [{ id: "c1", type: "frame", name: "Content / Body", x: 0, y: 0, width: 100, height: 100 }] },
  ]);
  expect(organized.issues.find((i) => i.code === "missing-section-banners")).toBeUndefined();
  expect(organized.issues.find((i) => i.code === "incomplete-section-banner")).toBeUndefined();
});

it("flags section banners missing chrome or with an uncolored Banner BG", () => {
  const summary = lintOpenPencilNodeTree([
    { id: "sa", type: "frame", name: "Section / 00 Brief", x: 0, y: 0, width: 1200, height: 96, children: [{ id: "ta", type: "text", name: "Section Title", x: 10, y: 10, width: 200, height: 30, fill: "#FFF", fontFamily: "Inter", fontWeight: 700, fontSize: 30, content: "Brief" }] },
    { id: "sb", type: "frame", name: "Section / 04 Foundations", x: 0, y: 0, width: 1200, height: 96, children: [
      { id: "tb", type: "text", name: "Section Title", x: 10, y: 10, width: 200, height: 30, fill: "#FFF", fontFamily: "Inter", fontWeight: 700, fontSize: 30, content: "Foundations" },
      { id: "bgb", type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill: "#FFFFFF" },
    ] },
    { id: "sc", type: "frame", name: "Section / 07 Screens", x: 0, y: 0, width: 1200, height: 96, children: [
      { id: "tc", type: "text", name: "Section Title", x: 10, y: 10, width: 200, height: 30, fill: "#FFF", fontFamily: "Inter", fontWeight: 700, fontSize: 30, content: "Screens" },
      { id: "bgc", type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill: "#BE123C" },
    ] },
  ]);
  const incomplete = summary.issues.filter((i) => i.code === "incomplete-section-banner");
  // 00 Brief is missing a Banner BG; 04 Foundations has a white (uncolored) Banner BG.
  expect(incomplete.find((i) => i.nodeId === "sa")).toBeDefined();
  expect(incomplete.find((i) => i.nodeId === "bgb")).toBeDefined();
  expect(incomplete.find((i) => i.nodeId === "bgc")).toBeUndefined();
});

it("requires every state-matrix cell to be filled and the matrix to have headers", () => {
  const summary = lintOpenPencilNodeTree([
    {
      id: "matrix",
      type: "frame",
      name: "State Matrix",
      x: 0,
      y: 0,
      width: 1200,
      height: 400,
      children: [
        { id: "empty-cell", type: "frame", name: "Matrix Cell / Button / Hover", x: 220, y: 60, width: 200, height: 140, children: [] },
        { id: "full-cell", type: "frame", name: "Matrix Cell / Button / Default", x: 20, y: 60, width: 200, height: 140, children: [
          { id: "variant", type: "frame", name: "Component / Button / Default", x: 30, y: 50, width: 130, height: 40, fill: "#0F766E", children: [
            { id: "lbl", type: "text", name: "Label", x: 0, y: 10, width: 130, height: 18, fill: "#FFF", fontFamily: "Inter", fontWeight: 600, fontSize: 14, content: "Save" },
          ] },
        ] },
      ],
    },
  ]);
  expect(summary.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "empty-state-cell", nodeId: "empty-cell" }),
      expect.objectContaining({ severity: "warning", code: "missing-state-matrix-headers" }),
    ]),
  );
  expect(summary.issues.find((i) => i.code === "empty-state-cell" && i.nodeId === "full-cell")).toBeUndefined();
});

it("handles the live op CLI paint-array fill shape without crashing", () => {
  const summary = lintOpenPencilNodeTree([
    {
      id: "sa",
      type: "frame",
      name: "Section / 00 Brief",
      x: 0,
      y: 0,
      width: 1200,
      height: 96,
      children: [
        { id: "ta", type: "text", name: "Section Title", x: 10, y: 10, width: 200, height: 30, fill: [{ type: "solid", color: "#FFFFFF" }], fontFamily: "Inter", fontWeight: 700, fontSize: 30, content: "Brief" },
        { id: "bg", type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill: [{ type: "solid", color: "#FFFFFF" }] },
      ],
    },
  ]);
  // A near-white paint-array Banner BG is detected as uncolored (and nothing throws).
  expect(summary.issues.some((i) => i.code === "incomplete-section-banner" && i.nodeId === "bg")).toBe(true);
});

it("falls back to op get when read-nodes returns empty for a valid file (formatting-sensitive CLI)", async () => {
  fx = await makeFixture();
  await mkdir(join(fx.root, "designs"), { recursive: true });
  await writeFile(join(fx.root, "designs/fmt.op"), "{}", "utf8");
  // Reproduce the OpenPencil quirk: read-nodes returns [] but get returns the tree.
  const bin = join(fx.base, "op-fallback-fake.mjs");
  const tree = JSON.stringify({
    nodes: [
      {
        id: "f",
        type: "frame",
        name: "Section / 00 Brief",
        x: 0,
        y: 0,
        width: 1200,
        height: 96,
        fill: [{ type: "solid", color: "#1F2937" }],
        children: [
          { id: "t", type: "text", name: "Section Title", x: 10, y: 10, width: 200, height: 30, fill: [{ type: "solid", color: "#FFFFFF" }], fontFamily: "Inter", fontWeight: 700, fontSize: 24, content: "Brief" },
          { id: "bg", type: "rectangle", name: "Banner BG", x: 0, y: 0, width: 1200, height: 96, fill: [{ type: "solid", color: "#1F2937" }] },
        ],
      },
    ],
  });
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "read-nodes") process.stdout.write(JSON.stringify({ nodes: [] }));
if (args[0] === "get") process.stdout.write(${JSON.stringify(tree)});
if (args[0] === "status") process.stdout.write("ok");
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  const config = loadConfig({
    transport: "http",
    env: { ALLOWED_ROOTS: fx.root, OWNER_TOKEN: "x".repeat(40), ENABLE_OPENPENCIL: "1", OPENPENCIL_CLI: bin },
    warn: silent,
  });

  // Lint must see the frame via the get fallback, not the empty read-nodes.
  const lint = await openPencilLintDesign(config, fx.guard, fx.ws, { path: "designs/fmt.op" });
  expect(lint.checkedFrames).toBeGreaterThan(0);
  expect(lint.visibleTextNodes).toBeGreaterThan(0);

  // Screenshot must render via the same fallback (tolerate a missing resvg optional dep).
  try {
    const shot = await openPencilScreenshot(config, fx.guard, fx.ws, { path: "designs/fmt.op" });
    expect(shot.nodeCount).toBeGreaterThan(0);
  } catch (err) {
    expect(String((err as Error).message)).toMatch(/resvg/i);
  }
});

async function fakeOpNodes(nodesJson: string): Promise<string> {
  const bin = join(fx.base, "op-nodes-fake.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "read-nodes") process.stdout.write(${JSON.stringify(nodesJson)});
if (args[0] === "status") process.stdout.write("ok");
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

it("renders a screenshot PNG from read-nodes output", async () => {
  fx = await makeFixture();
  await mkdir(join(fx.root, "designs"), { recursive: true });
  await writeFile(join(fx.root, "designs/shot.op"), "{}", "utf8");
  const op = await fakeOpNodes(
    JSON.stringify({
      nodes: [
        {
          id: "scr",
          type: "frame",
          name: "Screen / Demo / Desktop",
          x: 0,
          y: 0,
          width: 480,
          height: 320,
          fill: "#FFFFFF",
          children: [
            { id: "t", type: "text", name: "Title", x: 24, y: 24, width: 300, height: 32, fill: "#111827", fontFamily: "Inter", fontWeight: 700, fontSize: 24, content: "Dashboard" },
          ],
        },
      ],
    }),
  );
  const config = loadConfig({
    transport: "http",
    env: { ALLOWED_ROOTS: fx.root, OWNER_TOKEN: "x".repeat(40), ENABLE_OPENPENCIL: "1", OPENPENCIL_CLI: op },
    warn: silent,
  });

  try {
    const result = await openPencilScreenshot(config, fx.guard, fx.ws, { path: "designs/shot.op" });
    expect(result.width).toBe(480);
    expect(result.height).toBe(320);
    expect(result.nodeCount).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(result.pngBase64, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  } catch (err) {
    expect(String((err as Error).message)).toMatch(/resvg/i);
  }
});

async function fakeOp(): Promise<string> {
  const bin = join(fx.base, "op-fake.mjs");
  const log = join(fx.base, "op-log.jsonl");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const input = await new Promise((resolve) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => s += c);
  process.stdin.on("end", () => resolve(s));
});
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }) + "\\n");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const file = fileIndex >= 0 ? args[fileIndex + 1] : (args[0] === "design" || args[0] === "save" ? args[1] : undefined);
if ((args[0] === "design" || args[0] === "save" || args[0] === "insert" || args[0] === "update" || args[0] === "replace") && file) {
  mkdirSync(file.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(file, JSON.stringify({ args, input }) + "\\n");
}
if (args[0] === "status") process.stdout.write("ok");
if (args[0] === "read-nodes") process.stdout.write(JSON.stringify({ nodes: [] }));
if (args[0] === "selection") process.stdout.write(JSON.stringify({ selectedIds: [] }));
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

async function fakeOpStatus(port: number): Promise<string> {
  const bin = join(fx.base, "op-status-fake.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ running: true, port: ${JSON.stringify(port)}, url: "http://127.0.0.1:${port}" }));
}
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => res(port));
    });
  });
}

async function logLines(): Promise<Array<{ args: string[]; input: string; cwd: string }>> {
  const raw = await readFile(join(fx.base, "op-log.jsonl"), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string });
}

it("is disabled unless ENABLE_OPENPENCIL is set", async () => {
  fx = await makeFixture();
  const config = loadConfig({
    transport: "http",
    env: { ALLOWED_ROOTS: fx.root, OWNER_TOKEN: "x".repeat(40) },
    warn: silent,
  });

  await expect(openPencilStatus(config, fx.ws)).rejects.toBeInstanceOf(OpenPencilError);
});

it("runs OpenPencil design with fixed argv and prompt on stdin", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });

  const result = await openPencilDesign(config, fx.guard, fx.ws, {
    path: "designs/nested/dashboard.op",
    prompt: "Create a dashboard",
    canvasWidth: 1440,
    postProcess: true,
  });

  expect(result.exitCode).toBe(0);
  const entry = (await logLines())[0]!;
  expect(entry.args[0]).toBe("design");
  expect(entry.args[1]).toBe("-");
  expect(entry.args).toContain("--file");
  expect(entry.args).toContain("--canvas-width");
  expect(entry.args).toContain("--post-process");
  expect(entry.input).toBe("Create a dashboard");
  await expect(readFile(join(fx.root, "designs/nested/dashboard.op"), "utf8")).resolves.toContain("Create a dashboard");
});

it("rejects non-.op paths and path escapes", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });

  await expect(
    openPencilDesign(config, fx.guard, fx.ws, { path: "designs/dashboard.json", prompt: "x" }),
  ).rejects.toThrow(/\.op/i);
  await expect(
    openPencilDesign(config, fx.guard, fx.ws, { path: "../escape.op", prompt: "x" }),
  ).rejects.toThrow(/segment|relative|workspace/i);
  await expect(
    openPencilDesign(config, fx.guard, fx.ws, { path: "/tmp/escape.op", prompt: "x" }),
  ).rejects.toThrow(/relative/i);
});

it("opens existing .op files and saves to guarded .op targets", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  await mkdir(join(fx.root, "designs"), { recursive: true });
  await writeFile(join(fx.root, "designs/source.op"), "{}", "utf8");
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });

  await expect(openPencilOpen(config, fx.guard, fx.ws, "designs/source.op")).resolves.toMatchObject({ exitCode: 0 });
  await expect(openPencilSave(config, fx.guard, fx.ws, "designs/saved.op")).resolves.toMatchObject({ exitCode: 0 });

  const entries = await logLines();
  expect(entries.map((entry) => entry.args[0])).toEqual(["open", "save"]);
});

it("runs native OpenPencil node tools with fixed argv and JSON on stdin", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  await mkdir(join(fx.root, "designs"), { recursive: true });
  await writeFile(join(fx.root, "designs/source.op"), "{}", "utf8");
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });

  await expect(
    openPencilInsert(config, fx.guard, fx.ws, {
      path: "designs/source.op",
      parent: "page-1",
      index: 0,
      postProcess: true,
      node: { type: "frame", name: "Login page", x: 0, y: 0, width: 1440, height: 1024 },
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    openPencilUpdate(config, fx.guard, fx.ws, {
      id: "hero-title",
      patch: { content: "Sign in" },
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    openPencilReplace(config, fx.guard, fx.ws, {
      id: "hero-card",
      node: { type: "rectangle", name: "Card", x: 100, y: 100, width: 360, height: 420 },
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    openPencilMove(config, fx.guard, fx.ws, {
      id: "background",
      parent: "root-frame",
      index: 999,
      path: "designs/source.op",
    }),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(openPencilDelete(config, fx.guard, fx.ws, { id: "obsolete-node" })).resolves.toMatchObject({ exitCode: 0 });
  await expect(openPencilReadNodes(config, fx.guard, fx.ws, { ids: ["hero-title"], depth: 2 })).resolves.toMatchObject({
    exitCode: 0,
  });
  await expect(openPencilSelection(config, fx.ws)).resolves.toMatchObject({ exitCode: 0 });

  const entries = await logLines();
  expect(entries.map((entry) => entry.args[0])).toEqual([
    "insert",
    "update",
    "replace",
    "move",
    "delete",
    "read-nodes",
    "selection",
  ]);
  expect(entries[0]!.args).toContain("--file");
  expect(entries[0]!.args).toContain("--parent");
  expect(entries[0]!.args).toContain("--index");
  expect(entries[0]!.args).toContain("--post-process");
  expect(entries[0]!.args).not.toContain("Login page");
  expect(JSON.parse(entries[0]!.input)).toMatchObject({ type: "frame", name: "Login page" });
  expect(entries[1]!.args).toEqual(["update", "hero-title", "-"]);
  expect(JSON.parse(entries[1]!.input)).toEqual({ content: "Sign in" });
  expect(entries[2]!.args).toEqual(["replace", "hero-card", "-"]);
  expect(JSON.parse(entries[2]!.input)).toMatchObject({ type: "rectangle", name: "Card" });
  expect(entries[3]!.args).toEqual([
    "move",
    "background",
    "--parent",
    "root-frame",
    "--index",
    "999",
    "--file",
    join(fx.root, "designs/source.op"),
  ]);
  expect(entries[4]!.args).toEqual(["delete", "obsolete-node"]);
  expect(entries[5]!.args).toEqual(["read-nodes", "hero-title", "--depth", "2"]);
  expect(entries[6]!.args).toEqual(["selection"]);
});

it("guards optional .op paths for native node tools", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });

  await expect(
    openPencilInsert(config, fx.guard, fx.ws, {
      path: "../escape.op",
      node: { type: "frame" },
    }),
  ).rejects.toThrow(/segment|relative|workspace/i);
  await expect(
    openPencilReadNodes(config, fx.guard, fx.ws, {
      path: "missing.op",
    }),
  ).rejects.toThrow(/No such file/i);
});

it("proxies the OpenPencil web editor into a DevSpace preview URL", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const devspacePort = await freePort();
  const upstreamPostBodies: string[] = [];
  const currentDocument = {
    version: "1.0.0",
    pages: [
      {
        id: "page",
        name: "Page 1",
        children: [
          {
            id: "screen",
            type: "frame",
            name: "Screen",
            children: Array.from({ length: 24 }, (_, index) => ({
              id: `node-${index}`,
              type: "rectangle",
              name: `Layer ${index}`,
              children: [],
            })),
          },
        ],
      },
    ],
  };
  const upstream = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/mcp/document") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ version: 1, document: currentDocument }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/mcp/document") {
      let upstreamPostBody = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        upstreamPostBody += chunk;
      });
      req.on("end", () => {
        upstreamPostBodies.push(upstreamPostBody);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, bytes: Buffer.byteLength(upstreamPostBody) }));
      });
      return;
    }
    if (req.url === "/assets/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(
        'router.update({basepath:"",serializationAdapters:i}); function Xk(){return window.location.origin} fetch(`${Xk()}/api/mcp/document`); import("/assets/chunk.js"); const wasmBase="/canvaskit/"; const fontBasePath="/fonts/"; const inter="/fonts/inter-400.woff2"; const store={applyExternalDocument:null, loadDocument:(n,r,o,i)=>{}};',
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"/><link rel="stylesheet" href="/assets/app.css"/></head><body><title>OpenPencil Fake</title><script>import("/assets/app.js")</script><script src="/assets/app.js"></script></body></html>',
    );
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
      OPENPENCIL_PREVIEW_PORT: String(upstreamPort),
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const manager = app.locals.openPencilPreviewManager as OpenPencilPreviewManager;
  const preview = await manager.start({ timeoutMs: 2_000 });
  expect(preview.previewUrl).toContain("/openpencil-previews/");
  expect(preview.previewUrl).toMatch(/\/editor$/);

  const html = await (await fetch(preview.previewUrl)).text();
  expect(html).toContain("OpenPencil Fake");
  expect(html).toContain('<meta charset="utf-8"/>');
  expect(html).not.toContain('utf-8"/openpencil-previews/');
  expect(html).toContain(`/openpencil-previews/${preview.previewId}/assets/app.css`);
  expect(html).toContain(`/openpencil-previews/${preview.previewId}/assets/app.js`);

  const js = await (await fetch(`${preview.previewUrl.replace(/\/editor$/, "")}/assets/app.js`)).text();
  expect(js).toContain(`basepath:"/openpencil-previews/${preview.previewId}"`);
  expect(js).toContain(`import("/openpencil-previews/${preview.previewId}/assets/chunk.js")`);
  expect(js).toContain(`wasmBase="/openpencil-previews/${preview.previewId}/canvaskit/"`);
  expect(js).toContain(`fontBasePath="/openpencil-previews/${preview.previewId}/fonts/"`);
  expect(js).toContain(`inter="/openpencil-previews/${preview.previewId}/fonts/inter-400.woff2"`);
  expect(js).toContain(`function Xk(){return window.location.origin+"/openpencil-previews/${preview.previewId}"}`);
  expect(js).toContain("fetch(`${Xk()}/api/mcp/document`)");
  expect(js).toContain("DEVSPACE_OPENPENCIL_SYNC_URL");
  expect(js).toContain("__DEVSPACE_OPENPENCIL_SYNC_VERSION");
  expect(js).toContain(`/openpencil-previews/${preview.previewId}/api/mcp/document`);

  const blankPost = await fetch(`${preview.previewUrl.replace(/\/editor$/, "")}/api/mcp/document`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document: {
        version: "1.0.0",
        name: "Untitled",
        pages: [{ id: "page", name: "Page 1", children: [{ id: "frame", type: "frame", name: "Frame", children: [] }] }],
      },
      sourceClientId: "initial-editor",
    }),
  });
  expect(blankPost.status).toBe(200);
  await expect(blankPost.json()).resolves.toEqual({ ok: true, ignored: true, reason: "default_blank_document" });
  expect(upstreamPostBodies).toEqual([]);

  const destructivePost = await fetch(`${preview.previewUrl.replace(/\/editor$/, "")}/api/mcp/document`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document: {
        version: "1.0.0",
        pages: [
          {
            id: "page",
            name: "Page 1",
            children: [
              {
                id: "only",
                type: "frame",
                name: "Partially Loaded Screen",
                children: [{ id: "survivor", type: "rectangle", name: "One Layer", children: [] }],
              },
            ],
          },
        ],
      },
      sourceClientId: "drag-race",
    }),
  });
  expect(destructivePost.status).toBe(200);
  await expect(destructivePost.json()).resolves.toEqual({ ok: true, ignored: true, reason: "near_empty_document" });
  expect(upstreamPostBodies).toEqual([]);

  const post = await fetch(`${preview.previewUrl.replace(/\/editor$/, "")}/api/mcp/document`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: currentDocument, sourceClientId: "test" }),
  });
  expect(post.status).toBe(200);
  await expect(post.json()).resolves.toEqual({ ok: true, bytes: upstreamPostBodies[0]?.length });
  expect(JSON.parse(upstreamPostBodies[0] ?? "")).toEqual({ document: currentDocument, sourceClientId: "test" });
});

it("uses the running OpenPencil port reported by op status", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const fallbackPort = await freePort();
  const devspacePort = await freePort();
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Status Port</title>");
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOpStatus(upstreamPort);
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
      OPENPENCIL_PREVIEW_PORT: String(fallbackPort),
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const manager = app.locals.openPencilPreviewManager as OpenPencilPreviewManager;
  const preview = await manager.start({ timeoutMs: 2_000 });
  expect(preview.port).toBe(upstreamPort);
  expect(preview.previewUrl).toMatch(/\/editor$/);

  const html = await (await fetch(preview.previewUrl)).text();
  expect(html).toContain("Status Port");
});

it("attaches to an already-running OpenPencil preview without starting it", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const devspacePort = await freePort();
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Attach Only</title>");
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOpStatus(upstreamPort);
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const manager = app.locals.openPencilPreviewManager as OpenPencilPreviewManager;
  const preview = await manager.attach({ timeoutMs: 2_000 });
  expect(preview.port).toBe(upstreamPort);
  expect(preview.previewUrl).toMatch(/\/editor$/);

  const html = await (await fetch(preview.previewUrl)).text();
  expect(html).toContain("Attach Only");
});

it("restores a stale OpenPencil preview id when the app is still running", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const devspacePort = await freePort();
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Restored Preview</title>");
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOpStatus(upstreamPort);
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const staleUrl = `http://127.0.0.1:${devspacePort}/openpencil-previews/openpencil-0123456789abcdef0123456789abcdef/editor`;
  const res = await fetch(staleUrl);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Restored Preview");
});

it("restores a stale OpenPencil preview id from older variable-length ids", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const devspacePort = await freePort();
  const upstream = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Restored Preview</title>");
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOpStatus(upstreamPort);
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const staleUrl = `http://127.0.0.1:${devspacePort}/openpencil-previews/openpencil-c53970c69d9bc502a44a78c9f95bde7459/editor`;
  const res = await fetch(staleUrl);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Restored Preview");
});

it("routes the OpenPencil preview root to the editor", async () => {
  fx = await makeFixture();
  const upstreamPort = await freePort();
  const devspacePort = await freePort();
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${req.url}</title>`);
  });
  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));
  servers.push(upstream);

  const op = await fakeOpStatus(upstreamPort);
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      HOST: "127.0.0.1",
      PORT: String(devspacePort),
      PUBLIC_BASE_URL: `http://127.0.0.1:${devspacePort}`,
      ENABLE_OPENPENCIL: "1",
      OPENPENCIL_CLI: op,
    },
    warn: silent,
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const devspace = await new Promise<Server>((resolve) => {
    const server = app.listen(devspacePort, "127.0.0.1", () => resolve(server));
  });
  servers.push(devspace);

  const manager = app.locals.openPencilPreviewManager as OpenPencilPreviewManager;
  const preview = await manager.attach({ timeoutMs: 2_000 });
  const rootUrl = preview.previewUrl.replace(/\/editor$/, "/");
  const html = await (await fetch(rootUrl)).text();
  expect(html).toContain("<title>/editor</title>");
});
