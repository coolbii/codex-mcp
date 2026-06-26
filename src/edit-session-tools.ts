import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { audit } from "./audit-log.js";
import { SiteManager, type ProjectFile, type SiteDetails } from "./site-tools.js";

const SESSION_ID_BYTES = 32;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_SCENE_NODES = 300;
const MAX_SCENE_BYTES = 1_000_000;
const SCENE_PATH_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}\.json$/;

export interface CanvasNode {
  id: string;
  type: "rect" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  text?: string;
  fontSize?: number;
  color?: string;
}

export interface CanvasScene {
  version: 1;
  width: number;
  height: number;
  background: string;
  nodes: CanvasNode[];
}

interface EditSession {
  editSessionId: string;
  siteId: string;
  title: string;
  scenePath: string;
  createdAt: number;
  expiresAt: number;
}

export interface EditSessionDetails {
  editSessionId: string;
  siteId: string;
  title: string;
  scenePath: string;
  editUrl: string;
  previewUrl: string;
  sitePreviewUrl: string;
  expiresAt: string;
}

export interface CanvasProjectDetails extends SiteDetails {
  editSessionId: string;
  editUrl: string;
  scenePath: string;
  sitePreviewUrl: string;
  expiresAt: string;
}

function publicBase(config: AppConfig): string {
  return config.publicBaseUrl ?? `http://${config.host}:${config.port}`;
}

function newSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

function clampTtl(ttlSeconds?: number): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_MS;
  if (!Number.isInteger(ttlSeconds)) throw new Error("ttlSeconds must be an integer");
  const ms = ttlSeconds * 1000;
  if (ms < MIN_TTL_MS || ms > MAX_TTL_MS) {
    throw new Error("ttlSeconds must be between 60 and 604800");
  }
  return ms;
}

function assertScenePath(path: string): string {
  const segments = path.split("/");
  if (
    !SCENE_PATH_RE.test(path) ||
    path.includes("..") ||
    path.includes("//") ||
    segments.some((seg) => seg === ".git" || seg === "." || seg === "")
  ) {
    throw new Error("scenePath must be a safe project-relative .json path");
  }
  return path;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(value: unknown, fallback: string, max = 2000): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, max);
}

function color(value: unknown, fallback: string): string {
  const s = str(value, fallback, 80).trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  return fallback;
}

export function validateScene(input: unknown): CanvasScene {
  if (!input || typeof input !== "object") throw new Error("scene must be an object");
  const raw = input as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (rawNodes.length > MAX_SCENE_NODES) throw new Error(`scene has too many nodes (max ${MAX_SCENE_NODES})`);
  const scene: CanvasScene = {
    version: 1,
    width: num(raw.width, 1280, 320, 4096),
    height: num(raw.height, 800, 240, 4096),
    background: color(raw.background, "#f8faf8"),
    nodes: [],
  };
  const seen = new Set<string>();
  for (const entry of rawNodes) {
    if (!entry || typeof entry !== "object") continue;
    const nodeRaw = entry as Record<string, unknown>;
    const type = nodeRaw.type === "text" ? "text" : nodeRaw.type === "rect" ? "rect" : null;
    if (!type) continue;
    let id = str(nodeRaw.id, "", 80).trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id)) id = `node-${randomUUID().slice(0, 8)}`;
    seen.add(id);
    const node: CanvasNode = {
      id,
      type,
      x: num(nodeRaw.x, 40, -4096, 4096),
      y: num(nodeRaw.y, 40, -4096, 4096),
      width: num(nodeRaw.width, type === "text" ? 220 : 180, 8, 4096),
      height: num(nodeRaw.height, type === "text" ? 48 : 120, 8, 4096),
      fill: color(nodeRaw.fill, type === "text" ? "transparent" : "#ffffff"),
      stroke: color(nodeRaw.stroke, "#d0d7de"),
    };
    if (type === "text") {
      node.text = str(nodeRaw.text, "Text", 500);
      node.fontSize = num(nodeRaw.fontSize, 24, 8, 160);
      node.color = color(nodeRaw.color, "#17201b");
    }
    scene.nodes.push(node);
  }
  const bytes = Buffer.byteLength(JSON.stringify(scene), "utf8");
  if (bytes > MAX_SCENE_BYTES) throw new Error("scene is too large");
  return scene;
}

export function defaultScene(title: string): CanvasScene {
  return {
    version: 1,
    width: 1280,
    height: 800,
    background: "#f8faf8",
    nodes: [
      {
        id: "title",
        type: "text",
        x: 64,
        y: 56,
        width: 680,
        height: 72,
        text: title,
        fontSize: 42,
        color: "#17201b",
        fill: "transparent",
        stroke: "transparent",
      },
      { id: "panel-a", type: "rect", x: 64, y: 168, width: 360, height: 220, fill: "#ffffff", stroke: "#d6ddd8" },
      { id: "panel-b", type: "rect", x: 456, y: 168, width: 360, height: 220, fill: "#ffffff", stroke: "#d6ddd8" },
      { id: "panel-c", type: "rect", x: 848, y: 168, width: 360, height: 220, fill: "#ffffff", stroke: "#d6ddd8" },
      {
        id: "note",
        type: "text",
        x: 84,
        y: 430,
        width: 720,
        height: 44,
        text: "Drag shapes, edit text, then save.",
        fontSize: 24,
        color: "#52635b",
        fill: "transparent",
        stroke: "transparent",
      },
    ],
  };
}

function sceneJson(scene: CanvasScene): string {
  return JSON.stringify(scene, null, 2) + "\n";
}

function rendererHtml(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="canvas-preview" aria-label="${escapeHtml(title)}">
    <div id="canvas" class="canvas"></div>
  </main>
  <script src="./script.js"></script>
</body>
</html>
`;
}

const rendererCss = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201b;background:#edf1ee}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#edf1ee}.canvas-preview{min-height:100vh;display:grid;place-items:center;padding:24px}.canvas{position:relative;width:min(100%,1280px);aspect-ratio:1280/800;background:#f8faf8;border:1px solid #d6ddd8;box-shadow:0 18px 60px rgba(23,32,27,.12);overflow:hidden}.node{position:absolute;border-radius:8px}.text{display:flex;align-items:center;line-height:1.2;white-space:pre-wrap;overflow:hidden}`;

function rendererJs(scenePath: string): string {
  return `const canvas = document.getElementById("canvas");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function render(scene) {
  canvas.innerHTML = "";
  canvas.style.background = scene.background || "#f8faf8";
  canvas.style.aspectRatio = (scene.width || 1280) + "/" + (scene.height || 800);
  for (const node of scene.nodes || []) {
    const el = document.createElement("div");
    el.className = "node " + (node.type === "text" ? "text" : "rect");
    el.style.left = (node.x / scene.width * 100) + "%";
    el.style.top = (node.y / scene.height * 100) + "%";
    el.style.width = (node.width / scene.width * 100) + "%";
    el.style.height = (node.height / scene.height * 100) + "%";
    el.style.background = node.fill || "transparent";
    el.style.border = node.stroke && node.stroke !== "transparent" ? "1px solid " + node.stroke : "0";
    if (node.type === "text") {
      el.style.color = node.color || "#17201b";
      el.style.fontSize = Math.max(8, Number(node.fontSize) || 20) + "px";
      el.textContent = node.text || "";
    }
    canvas.appendChild(el);
  }
}
fetch("./${scenePath}").then((r) => r.json()).then(render).catch(() => {
  canvas.textContent = "Canvas scene could not be loaded.";
});
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function editHtml(session: EditSession): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Edit ${escapeHtml(session.title)}</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17201b;background:#eef1ee}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#eef1ee}.toolbar{height:52px;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #d6ddd8;background:#f8faf8}.toolbar strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}button,input{font:inherit}button{border:1px solid #c9d2cc;background:#fff;color:#17201b;border-radius:7px;padding:7px 10px;cursor:pointer}button.primary{background:#17201b;color:#fff;border-color:#17201b}.status{color:#52635b;font-size:13px}.workspace{height:calc(100vh - 52px);overflow:auto;padding:24px}.canvas{position:relative;margin:0 auto;background:#f8faf8;border:1px solid #c9d2cc;box-shadow:0 18px 60px rgba(23,32,27,.12);transform-origin:top center}.node{position:absolute;border-radius:8px;cursor:move;user-select:none}.node.selected{outline:2px solid #2675d7;outline-offset:2px}.text{display:flex;align-items:center;white-space:pre-wrap;overflow:hidden;line-height:1.2}.handle{position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;border-radius:50%;background:#2675d7;border:2px solid #fff;cursor:nwse-resize}.editor{display:none;position:fixed;right:16px;top:68px;width:min(320px,calc(100vw - 32px));padding:12px;border:1px solid #c9d2cc;border-radius:8px;background:#fff;box-shadow:0 18px 60px rgba(23,32,27,.14)}.editor.open{display:grid;gap:10px}.editor label{display:grid;gap:4px;color:#52635b;font-size:12px}.editor input,.editor textarea{width:100%;border:1px solid #c9d2cc;border-radius:7px;padding:7px}.editor textarea{min-height:80px;resize:vertical}
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>${escapeHtml(session.title)}</strong>
    <button type="button" id="addRect">Rect</button>
    <button type="button" id="addText">Text</button>
    <button type="button" id="delete">Delete</button>
    <button type="button" id="save" class="primary">Save</button>
    <span id="status" class="status"></span>
  </div>
  <div class="workspace"><div id="canvas" class="canvas"></div></div>
  <form id="editor" class="editor">
    <label>Text<textarea id="text"></textarea></label>
    <label>Fill<input id="fill" type="text"></label>
    <label>Stroke<input id="stroke" type="text"></label>
    <label>Color<input id="color" type="text"></label>
    <label>Font size<input id="fontSize" type="number" min="8" max="160"></label>
  </form>
  <script>
    const sessionId = ${JSON.stringify(session.editSessionId)};
    const canvas = document.getElementById("canvas");
    const statusEl = document.getElementById("status");
    const editor = document.getElementById("editor");
    const addRectBtn = document.getElementById("addRect");
    const addTextBtn = document.getElementById("addText");
    const deleteBtn = document.getElementById("delete");
    const saveBtn = document.getElementById("save");
    const fields = {
      text: document.getElementById("text"),
      fill: document.getElementById("fill"),
      stroke: document.getElementById("stroke"),
      color: document.getElementById("color"),
      fontSize: document.getElementById("fontSize")
    };
    let scene = null, selected = null, action = null;
    const setStatus = (text) => { statusEl.textContent = text; };
    const px = (v) => Math.round(v) + "px";
    function selectedNode(){ return scene.nodes.find(n => n.id === selected) || null; }
    function render(){
      canvas.innerHTML = "";
      canvas.style.width = px(scene.width);
      canvas.style.height = px(scene.height);
      canvas.style.background = scene.background;
      for (const node of scene.nodes) {
        const el = document.createElement("div");
        el.className = "node " + node.type + (node.id === selected ? " selected" : "");
        el.dataset.id = node.id;
        Object.assign(el.style, { left:px(node.x), top:px(node.y), width:px(node.width), height:px(node.height), background:node.fill || "transparent", border: node.stroke && node.stroke !== "transparent" ? "1px solid " + node.stroke : "0" });
        if (node.type === "text") {
          el.textContent = node.text || "";
          el.style.color = node.color || "#17201b";
          el.style.fontSize = px(node.fontSize || 20);
        }
        const handle = document.createElement("span");
        handle.className = "handle";
        handle.addEventListener("pointerdown", (event) => start(event, node.id, "resize"));
        el.appendChild(handle);
        el.addEventListener("pointerdown", (event) => start(event, node.id, "move"));
        canvas.appendChild(el);
      }
      syncEditor();
    }
    function syncEditor(){
      const n = selectedNode();
      editor.classList.toggle("open", !!n);
      if (!n) return;
      fields.text.value = n.text || "";
      fields.fill.value = n.fill || "";
      fields.stroke.value = n.stroke || "";
      fields.color.value = n.color || "";
      fields.fontSize.value = n.fontSize || "";
    }
    function start(event, id, mode){
      event.preventDefault();
      event.stopPropagation();
      selected = id;
      const n = selectedNode();
      action = { mode, x:event.clientX, y:event.clientY, nx:n.x, ny:n.y, nw:n.width, nh:n.height };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      render();
    }
    window.addEventListener("pointermove", (event) => {
      if (!action) return;
      const n = selectedNode();
      if (!n) return;
      const dx = event.clientX - action.x, dy = event.clientY - action.y;
      if (action.mode === "move") { n.x = action.nx + dx; n.y = action.ny + dy; }
      else { n.width = Math.max(8, action.nw + dx); n.height = Math.max(8, action.nh + dy); }
      render();
    });
    window.addEventListener("pointerup", () => { action = null; });
    canvas.addEventListener("pointerdown", () => { selected = null; render(); });
    function add(type){
      const node = type === "text"
        ? { id:"node-" + Math.random().toString(36).slice(2,8), type, x:80, y:80, width:260, height:56, text:"Text", fontSize:24, color:"#17201b", fill:"transparent", stroke:"transparent" }
        : { id:"node-" + Math.random().toString(36).slice(2,8), type, x:80, y:80, width:220, height:140, fill:"#ffffff", stroke:"#d6ddd8" };
      scene.nodes.push(node); selected = node.id; render();
    }
    addRectBtn.onclick = () => add("rect");
    addTextBtn.onclick = () => add("text");
    deleteBtn.onclick = () => { if (!selected) return; scene.nodes = scene.nodes.filter(n => n.id !== selected); selected = null; render(); };
    for (const id of ["text","fill","stroke","color","fontSize"]) {
      fields[id].addEventListener("input", () => {
        const n = selectedNode(); if (!n) return;
        if (id === "fontSize") n[id] = Number(fields.fontSize.value) || 24;
        else n[id] = fields[id].value;
        render();
      });
    }
    saveBtn.onclick = async () => {
      setStatus("Saving...");
      const res = await fetch("./save", { method:"POST", headers:{ "content-type":"application/json", "x-devspace-edit-session":sessionId }, body:JSON.stringify({ scene }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setStatus(data.error || "Save failed"); return; }
      setStatus("Saved " + (data.latestVersion ? data.latestVersion.slice(0,7) : ""));
    };
    fetch("./scene").then(r => r.json()).then((data) => { scene = data.scene; render(); }).catch(() => setStatus("Could not load scene"));
  </script>
</body>
</html>`;
}

export class EditSessionManager {
  private readonly sessions = new Map<string, EditSession>();
  private readonly storePath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly siteManager: SiteManager,
  ) {
    this.storePath = config.editSessionStorePath;
    this.load();
  }

  /** Load persisted sessions (dropping expired) so edit URLs survive restarts.
   *  devspace restarts on every deploy AND on every .env hot-reload, which would
   *  otherwise invalidate every outstanding edit link. */
  private load(): void {
    try {
      if (!existsSync(this.storePath)) return;
      const arr = JSON.parse(readFileSync(this.storePath, "utf8")) as unknown;
      const now = Date.now();
      for (const s of Array.isArray(arr) ? (arr as EditSession[]) : []) {
        if (
          s &&
          typeof s.editSessionId === "string" &&
          typeof s.siteId === "string" &&
          typeof s.scenePath === "string" &&
          typeof s.expiresAt === "number" &&
          s.expiresAt > now
        ) {
          this.sessions.set(s.editSessionId, s);
        }
      }
    } catch {
      // Corrupt/unreadable store — start empty rather than crash.
    }
  }

  /** Atomically persist sessions. The ids are capabilities, so the file is 0600
   *  (mirrors the OAuth store). Best-effort: a write failure must not break the
   *  request that triggered it. */
  private persist(): void {
    try {
      const dir = dirname(this.storePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.edit-sessions.${randomUUID()}.tmp`);
      writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch {
      /* best-effort */
    }
  }

  async createCanvasProject(input: { title: string; scene?: unknown; ttlSeconds?: number }): Promise<CanvasProjectDetails> {
    const scene = validateScene(input.scene ?? defaultScene(input.title));
    const files = this.projectFiles(input.title, "scene.json", scene);
    const site = await this.siteManager.createProject({
      title: input.title,
      message: `Create editable canvas: ${input.title}`,
      files,
    });
    const session = await this.createSession({ siteId: site.siteId, title: site.title, ttlSeconds: input.ttlSeconds });
    return { ...site, ...session, sitePreviewUrl: site.previewUrl };
  }

  async createSession(input: { siteId: string; title?: string; scenePath?: string; ttlSeconds?: number }): Promise<EditSessionDetails> {
    const site = await this.siteManager.getSite(input.siteId);
    const scenePath = assertScenePath(input.scenePath ?? "scene.json");
    await this.loadScene(site.siteId, scenePath, site.title);
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.sessions.delete(oldest.editSessionId);
    }
    const now = Date.now();
    const editSessionId = newSessionId();
    const session: EditSession = {
      editSessionId,
      siteId: site.siteId,
      title: input.title?.trim() || site.title,
      scenePath,
      createdAt: now,
      expiresAt: now + clampTtl(input.ttlSeconds),
    };
    this.sessions.set(editSessionId, session);
    this.persist();
    return this.details(session, site.previewUrl);
  }

  async scene(editSessionId: string): Promise<{ session: EditSessionDetails; scene: CanvasScene }> {
    const session = this.requireSession(editSessionId);
    const site = await this.siteManager.getSite(session.siteId);
    return {
      session: this.details(session, site.previewUrl),
      scene: await this.loadScene(session.siteId, session.scenePath, session.title),
    };
  }

  async save(editSessionId: string, input: unknown): Promise<{ session: EditSessionDetails; site: SiteDetails }> {
    const session = this.requireSession(editSessionId);
    const raw = input && typeof input === "object" && "scene" in input ? (input as { scene: unknown }).scene : input;
    const scene = validateScene(raw);
    const site = await this.siteManager.updateProject({
      siteId: session.siteId,
      message: "Save canvas edit",
      files: this.projectFiles(session.title, session.scenePath, scene),
    });
    audit({ event: "tool_call", tool: "save_edit_session", path: session.scenePath, detail: session.siteId, success: true });
    return { session: this.details(session, site.previewUrl), site };
  }

  async handleEditor(req: Request, res: Response): Promise<void> {
    const session = this.requireSession(String(req.params[0] ?? ""));
    res.type("text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(editHtml(session));
  }

  async handleScene(req: Request, res: Response): Promise<void> {
    const out = await this.scene(String(req.params[0] ?? ""));
    res.setHeader("Cache-Control", "no-store");
    res.json(out);
  }

  async handleSave(req: Request, res: Response): Promise<void> {
    const editSessionId = String(req.params[0] ?? "");
    if (req.headers["x-devspace-edit-session"] !== editSessionId) {
      res.status(403).json({ error: "missing_edit_session_header" });
      return;
    }
    const out = await this.save(editSessionId, req.body);
    res.json({
      ok: true,
      editSessionId,
      siteId: out.site.siteId,
      previewUrl: out.site.previewUrl,
      latestVersion: out.site.latestVersion,
      expiresAt: out.session.expiresAt,
    });
  }

  private async loadScene(siteId: string, scenePath: string, title: string): Promise<CanvasScene> {
    try {
      const file = await this.siteManager.previewFile(siteId, scenePath);
      const raw = file.body ? file.body.toString("utf8") : await readFile(file.absolutePath as string, "utf8");
      return validateScene(JSON.parse(raw) as unknown);
    } catch {
      return defaultScene(title);
    }
  }

  private projectFiles(title: string, scenePath: string, scene: CanvasScene): ProjectFile[] {
    return [
      { path: "index.html", content: rendererHtml(title) },
      { path: "styles.css", content: rendererCss },
      { path: "script.js", content: rendererJs(scenePath) },
      { path: scenePath, content: sceneJson(scene) },
    ];
  }

  private details(session: EditSession, sitePreviewUrl: string): EditSessionDetails {
    const editUrl = `${publicBase(this.config)}/edit-sessions/${encodeURIComponent(session.editSessionId)}/`;
    return {
      editSessionId: session.editSessionId,
      siteId: session.siteId,
      title: session.title,
      scenePath: session.scenePath,
      editUrl,
      previewUrl: editUrl,
      sitePreviewUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  private requireSession(editSessionId: string): EditSession {
    this.prune();
    const session = this.sessions.get(editSessionId);
    if (!session) throw new Error("Unknown or expired edit session");
    return session;
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
