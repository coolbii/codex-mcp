/**
 * mcp-server.ts — wire the pure primitives to MCP tools.
 *
 * One McpServer is built per session (HTTP) or once (stdio). HTTP may pass a
 * shared WorkspaceRegistry because some clients issue tool calls across
 * multiple MCP transport sessions while expecting workspace handles to remain
 * valid. The PathGuard and AppConfig are shared (immutable).
 *
 * Tool annotations matter: `readOnlyHint: true` lets clients (notably ChatGPT)
 * run a tool without a per-call approval prompt; write/exec tools set
 * `destructiveHint: true` so they prompt. These hints are advisory to clients —
 * the real enforcement is the PathGuard + auth + shell allowlist.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { PathGuard } from "./path-guard.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { readFile, listDirectory } from "./fs-tools.js";
import { findFiles, searchFiles } from "./search-tools.js";
import { writeFile, editFile, showDiff } from "./edit-tools.js";
import { runCommand } from "./shell-tools.js";
import { installPackages } from "./package-tools.js";
import { createApp } from "./app-tools.js";
import { AppPreviewManager } from "./app-preview-tools.js";
import { audit } from "./audit-log.js";
import { SiteManager, SITE_ARCHETYPES } from "./site-tools.js";
import { SecretGuard } from "./secret-guard.js";
import { EditSessionManager } from "./edit-session-tools.js";
import { OpenPencilPreviewManager } from "./openpencil-preview-tools.js";
import { extractDesignReference, ExtractReferenceError } from "./extract-reference.js";
import {
  openPencilDesign,
  openPencilDelete,
  openPencilGet,
  openPencilInsert,
  openPencilInsertSectionBand,
  openPencilInsertStateMatrix,
  openPencilLintDesign,
  openPencilMove,
  openPencilOpen,
  openPencilReadNodes,
  openPencilReplace,
  openPencilSave,
  openPencilScreenshot,
  openPencilSelection,
  openPencilStart,
  openPencilStatus,
  openPencilUpdate,
} from "./openpencil-tools.js";

const SERVER_NAME = "devspace";
const SERVER_VERSION = "0.1.0";
const SITE_WIDGET_URI = "ui://devspace/site-preview.v3.html";
const SITE_WIDGET_URI_ALIASES = [
  SITE_WIDGET_URI,
  "ui://devspace/site-preview.v2.html",
  "ui://devspace/site-preview.html",
] as const;
// ChatGPT's Apps SDK ("skybridge") host only MOUNTS a component whose resource
// is served as exactly this MIME. The newer MCP ext-apps profile MIME
// ("text/html;profile=mcp-app") is NOT recognised by today's skybridge host and
// makes ChatGPT show "error loading app" / fall back to text. Both the resource
// descriptor (registerResource) and the resources/read contents[] derive from
// this one constant, so they always match. (Ref: openai/openai-apps-sdk-examples
// pizzaz + kitchen_sink servers, which hardcode this everywhere.)
const SITE_WIDGET_MIME = "text/html+skybridge";
const SITE_DESIGN_DIRECTION =
  "Generated sites should feel hand-designed, restrained, and domain-specific. " +
  "Avoid generic AI SaaS styling: no decorative gradient blobs/orbs, no fake dashboard screenshots, " +
  "no over-rounded card stacks, no purple-blue one-note palettes, no vague feature copy, and no oversized hero unless the brief requires it. " +
  "Prefer quiet typography, clear hierarchy, compact sections, restrained color, real content structure, accessible contrast, " +
  "8px-or-less radii, stable responsive layout, and complete HTML/CSS/JS files. " +
  "Prefer choosing an archetype and omitting raw html/css unless the user explicitly asks for custom code.";
const OPENPENCIL_AUTHORING_GUIDANCE =
  "OpenPencil .op authoring — staged, gated workflow; do NOT jump straight to drawing, and do not hand-write/patch raw .op JSON unless the user asks for raw-file repair. " +
  "1) CLARIFY FIRST. Before any openpencil_insert, ask the user and WAIT for answers: (a) who is the user and the one job; (b) surface + viewport(s); (c) three adjectives for the feel (not 'modern'); (d) reference source (Figma/URL/screenshots) to extract structure+tokens from, not copy; (e) existing brand tokens, or should you propose a set for approval; (f) which components are in scope; (g) which screens; (h) which of the 10 states matter; (i) is the deliverable a full design package or a single screen. Summarize the answers as a one-paragraph Brief and get an explicit 'go'. " +
  "2) FOUNDATIONS BEFORE SCREENS. Define color/type/spacing/radius tokens as named foundation layers and reuse them everywhere; no ad-hoc per-screen values. " +
  "3) BUILD NODE-BY-NODE with openpencil_insert/update/move/replace (prefer this over op design, which you cannot organize or fix). Organize nodes as Screen > Foundations/Components/Layout/Content/States with semantic layer names. " +
  "4) For a design PACKAGE (not a single screen), build the '00 Brief … 10 Handoff' rail with openpencil_insert_section_band — ONE call per section (00..10), into a .op file path. It reliably authors a lint-clean 'Section / NN <Title>' band (full-width colored Banner BG as the last child in the category color, Index Chip+Number, white Section Title, optional Section Subtitle) and auto-stacks bands down the page. Do NOT hand-build bands with raw write_file or openpencil_insert (op insert rejects string fills and `op insert --file` does not persist to the file). Fills are always arrays: [{\"type\":\"solid\",\"color\":\"#0F766E\"}]. Build band 06 (the state matrix) with openpencil_insert_state_matrix — pass the components and the states and it authors the whole grid (Matrix / Header Row + one Matrix / Row per component, every cell filled) lint-clean in one call. " +
  '5) Every text node needs an explicit bundled fontFamily ("Inter" for English UI, "Noto Sans SC" for Chinese UI) plus a concrete fontWeight; size text to its box, wrap long headlines, and prevent overlap. Put full-frame backgrounds as the LAST child of their parent (openpencil_move index 999). ' +
  "6) VISUAL REVIEW BEFORE SAVING. Run openpencil_screenshot to get a PNG of the canvas/each screen and LOOK at it: any overlap, clipping, or misalignment? are the section bars visible and COLORED? are all matrix cells filled? is the primary action obvious (squint test)? does it look professional and good to a human, matching the three adjectives? Fix problems with openpencil_update/openpencil_move and screenshot again. openpencil_save is gated on having run openpencil_screenshot first. " +
  "7) Run openpencil_lint_design and fix errors before saving — missing-font-family, background-z-order, empty-frame, missing-section-banners, empty-state-cell — then verify any .op write with openpencil_get. " +
  "When the user says 'Apple-like', they mean file organization, section/state bars, component/state coverage, and handoff quality — NOT Apple visual style. Treat reference images/sites as research: extract structure, flow, tokens, and component vocabulary; do not copy the visual design. Avoid generic AI styling, decorative gradients/blobs, vague hero copy, unreadable placeholder text, random cards, inconsistent controls, and flat gray wireframes unless the user asks for wireframes. " +
  "If raw .op JSON must be created or repaired, keep the native shape: top-level { version, name, pages, children } with the active canvas under pages[].children (root children usually an empty array); nodes use id, type, name, x, y, width, height, fill, stroke, children.";

const entrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
});
const matchSchema = z.object({
  file: z.string(),
  lineNumber: z.number().int().positive(),
  line: z.string(),
});
const siteVersionSchema = z.object({
  version: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
const siteTagSchema = z.object({
  tag: z.string(),
  version: z.string(),
  createdAt: z.string(),
});
const siteSummarySchema = z.object({
  siteId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  previewUrl: z.string(),
  latestVersion: z.string().nullable(),
  archetype: z.enum(SITE_ARCHETYPES).optional(),
});
const siteDetailsSchema = siteSummarySchema.extend({
  localPath: z.string(),
  versions: z.array(siteVersionSchema),
  tags: z.array(siteTagSchema),
});
const appPreviewSchema = z.object({
  previewId: z.string(),
  title: z.string(),
  previewUrl: z.string(),
  localUrl: z.string(),
  workspaceRoot: z.string(),
  projectName: z.string(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
  port: z.number().int().positive(),
  command: z.string(),
  args: z.array(z.string()),
  installed: z.boolean(),
  installExitCode: z.number().int().nullable(),
  ready: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
});
const processResultSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
});
const openPencilStatusSchema = processResultSchema.extend({
  enabled: z.boolean(),
});
const openPencilPreviewSchema = z.object({
  previewId: z.string(),
  title: z.string(),
  previewUrl: z.string(),
  localUrl: z.string(),
  port: z.number().int().positive(),
  ready: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  siteId: z.string().optional(),
  latestVersion: z.string().nullable().optional(),
});
const openPencilLintIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().optional(),
  nodeName: z.string().optional(),
  fix: z.string().optional(),
});
const openPencilLintSchema = processResultSchema.extend({
  ok: z.boolean(),
  checkedFrames: z.number().int().nonnegative(),
  visibleElementNodes: z.number().int().nonnegative(),
  visibleTextNodes: z.number().int().nonnegative(),
  issues: z.array(openPencilLintIssueSchema),
});
const editSessionSchema = z.object({
  editSessionId: z.string(),
  siteId: z.string(),
  title: z.string(),
  scenePath: z.string(),
  editUrl: z.string(),
  previewUrl: z.string(),
  sitePreviewUrl: z.string(),
  expiresAt: z.string(),
});
const canvasProjectSchema = siteDetailsSchema.extend({
  editSessionId: z.string(),
  editUrl: z.string(),
  scenePath: z.string(),
  sitePreviewUrl: z.string(),
  expiresAt: z.string(),
});
const canvasNodeSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["rect", "text"]),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  color: z.string().optional(),
});
const canvasSceneSchema = z.object({
  version: z.literal(1).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  background: z.string().optional(),
  nodes: z.array(canvasNodeSchema).max(300).optional(),
});

function text(s: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: s }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function sitePreviewResult(message: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    _meta: {
      "openai/outputTemplate": SITE_WIDGET_URI,
      "openai/toolInvocation/invoking": "Rendering preview",
      "openai/toolInvocation/invoked": "Preview ready",
    },
  };
}

function previewResult(message: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    _meta: {
      "openai/outputTemplate": SITE_WIDGET_URI,
      "openai/toolInvocation/invoking": "Rendering preview",
      "openai/toolInvocation/invoked": "Preview ready",
    },
  };
}

function siteWidgetHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DevSpace Preview</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #0f1115; color: #eef1f5; }
      .bar { min-height: 48px; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.12); background: #151922; }
      .title { min-width: 0; flex: 1; }
      .title strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
      .title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9aa4b2; font-size: 12px; }
      a, button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #202633; color: #eef1f5; padding: 7px 10px; font: inherit; font-size: 13px; text-decoration: none; cursor: pointer; }
      #app { min-height: 760px; }
      iframe { display: block; width: 100%; height: 712px; min-height: 712px; border: 0; background: white; }
      .empty { display: grid; min-height: 760px; place-items: center; color: #9aa4b2; padding: 24px; text-align: center; }
    </style>
  </head>
  <body>
    <div id="app" class="empty">Waiting for a DevSpace preview...</div>
    <script>
      let latestOutput = null;
      function structuredFromEnvelope(envelope) {
        if (!envelope || typeof envelope !== "object") return null;
        if (envelope.structuredContent) return envelope.structuredContent;
        if (envelope.result?.structuredContent) return envelope.result.structuredContent;
        if (envelope.call_tool_result?.structuredContent) return envelope.call_tool_result.structuredContent;
        if (envelope.mcp_tool_result?.structuredContent) return envelope.mcp_tool_result.structuredContent;
        if (envelope.mcp_tool_result?.result?.structuredContent) return envelope.mcp_tool_result.result.structuredContent;
        return null;
      }
      function getOutput() {
        return latestOutput ||
          window.openai?.toolOutput ||
          structuredFromEnvelope(window.openai?.toolResponseMetadata) ||
          {};
      }
      function render() {
        const data = getOutput();
        const previewUrl = data.previewUrl;
        const siteId = data.siteId || "";
        const title = data.title || "DevSpace preview";
        const version = data.latestVersion || "";
        const app = document.getElementById("app");
        if (!previewUrl) {
          app.className = "empty";
          app.textContent = "No preview URL returned.";
          return;
        }
        app.className = "";
        app.innerHTML = '<div class="bar"><div class="title"><strong></strong><span></span></div><button type="button" id="refresh">Refresh</button><a id="open" target="_blank" rel="noreferrer">Open</a></div><iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"></iframe>';
        app.querySelector("strong").textContent = title;
        app.querySelector("span").textContent = siteId + (version ? " · " + version.slice(0, 7) : "");
        app.querySelector("iframe").src = previewUrl;
        app.querySelector("#open").href = previewUrl;
        app.querySelector("#refresh").addEventListener("click", () => {
          const frame = app.querySelector("iframe");
          frame.src = previewUrl + (previewUrl.includes("?") ? "&" : "?") + "t=" + Date.now();
        });
      }
      render();
      setTimeout(render, 100);
      setTimeout(render, 500);
      setTimeout(render, 1500);
      window.addEventListener("message", (event) => {
        const message = typeof event.data === "string" ? (() => {
          try { return JSON.parse(event.data); } catch { return null; }
        })() : event.data;
        if (!message || typeof message !== "object") return;
        if (message.method === "ui/notifications/tool-result") {
          latestOutput = structuredFromEnvelope(message.params) || message.params?.structuredContent || null;
          render();
          return;
        }
        if (message.method === "ui/notifications/tool-input") return;
        render();
      });
      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || {};
        if (globals.toolOutput !== undefined) latestOutput = globals.toolOutput;
        render();
      });
    </script>
  </body>
</html>`;
}

export function buildMcpServer(
  config: AppConfig,
  guard: PathGuard,
  registry = new WorkspaceRegistry(guard, config.allowedRoots),
  appPreviewManager = new AppPreviewManager(config, guard),
  editSessionManager?: EditSessionManager,
  openPencilPreviewManager = new OpenPencilPreviewManager(config),
  visualReviewedWorkspaces: Set<string> = new Set<string>(),
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { logging: {}, tools: {} },
      instructions:
        "Sandboxed local filesystem (and optional restricted shell) over MCP. " +
        "First call list_roots to see what you may open, then open_workspace(path) " +
        "to get a workspaceId; pass that id to every other call. Discover with " +
        "list_directory / find_files / search_files before read_file. To change a " +
        "file, preview with show_diff, then write_file (new/overwrite) or edit_file " +
        "(exact oldText→newText replacement). All paths are workspace-relative. " +
        "SAFETY RULES (always follow): Never read, search, or display secret/credential " +
        "files — .env / .env.*, *.key, *.pem, id_rsa*, .npmrc, .netrc, tokens, anything " +
        "under .ssh / .aws / .gnupg, or files named like 'secret'/'credentials'. If a value " +
        "is needed, ask the user to paste just that value. If a tool result says a path is " +
        "BLOCKED or shows [redacted], do NOT try to work around it (no alternate paths, " +
        "encodings, or version tricks) — tell the user. Writes: only create or modify files " +
        "the current request needs; never delete or overwrite a file you did not create in " +
        "this conversation without first showing show_diff and getting explicit confirmation; " +
        "never write outside the workspace you were given. " +
        "For create_site / create_project and their updates: " +
        SITE_DESIGN_DIRECTION +
        " If the user asks for OpenPencil, the original OpenPencil interface, native design editing, or Figma-like manipulation handles, prefer the openpencil_* tools over create_canvas_project. create_canvas_project is only a lightweight DevSpace fallback editor.",
    },
  );

  /** Shared invoke wrapper: time, audit, and convert thrown errors to results. */
  async function invoke(
    tool: string,
    meta: { workspaceId?: string; path?: string },
    fn: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const start = Date.now();
    try {
      const result = await fn();
      audit({
        event: "tool_call",
        tool,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...(meta.path ? { path: meta.path } : {}),
        success: result.isError !== true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      const e = err as Error;
      audit({
        event: "tool_error",
        tool,
        ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...(meta.path ? { path: meta.path } : {}),
        success: false,
        durationMs: Date.now() - start,
        detail: e.name,
      });
      return errorResult(`${tool} failed: ${e.message}`);
    }
  }

  const RO = { readOnlyHint: true, openWorldHint: false } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
  const secretGuard = new SecretGuard({ extraDenyPatterns: config.denyPaths, scanContent: config.secretScan });
  const siteManager = new SiteManager(config, guard);
  // Visual-review gate state (`visualReviewedWorkspaces`) is passed in so it is
  // SHARED across HTTP sessions / ephemeral servers. ChatGPT's stateless tool calls
  // each get a fresh McpServer, so a per-instance Set would never see the
  // screenshot that unlocked the gate (the save would always be blocked).
  // openpencil_screenshot adds the workspaceId; openpencil_save checks it
  // (force:true bypasses).
  const canvasSessions = editSessionManager ?? new EditSessionManager(config, siteManager);
  const widgetOrigin = config.publicBaseUrl ?? `http://${config.host}:${config.port}`;
  const widgetMeta = {
    "openai/widgetDescription": "Interactive preview for locally generated DevSpace sites.",
    "openai/widgetPrefersBorder": true,
    "openai/widgetDomain": widgetOrigin,
    "openai/widgetCSP": {
      connect_domains: [widgetOrigin],
      resource_domains: [widgetOrigin],
      frame_domains: [widgetOrigin],
    },
    ui: {
      prefersBorder: true,
      domain: widgetOrigin,
      csp: {
        connectDomains: [widgetOrigin],
        resourceDomains: [widgetOrigin],
        frameDomains: [widgetOrigin],
      },
    },
  };

  for (const [index, uri] of SITE_WIDGET_URI_ALIASES.entries()) {
    server.registerResource(
      index === 0 ? "site-preview-widget" : `site-preview-widget-compat-${index}`,
      uri,
      {
        title: "DevSpace Site Preview",
        mimeType: SITE_WIDGET_MIME,
        description: "Renders a generated DevSpace site preview inside ChatGPT.",
        _meta: widgetMeta,
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: SITE_WIDGET_MIME,
            text: siteWidgetHtml(),
            _meta: widgetMeta,
          },
        ],
      }),
    );
  }

  // --- discovery -----------------------------------------------------------

  server.registerTool(
    "list_roots",
    {
      title: "List allowed roots",
      description: "List the directories this server is permitted to open.",
      inputSchema: {},
      outputSchema: { roots: z.array(z.string()) },
      annotations: { ...RO, title: "List allowed roots" },
    },
    async () =>
      invoke("list_roots", {}, async () => {
        const roots = registry.roots();
        return text(
          roots.length ? roots.map((r) => `- ${r}`).join("\n") : "(no roots configured)",
          { roots },
        );
      }),
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a directory (an allowed root, or a folder beneath one) and get a workspaceId to use for all later calls.",
      inputSchema: { path: z.string().describe("absolute path, or path relative to an allowed root") },
      outputSchema: { workspaceId: z.string(), root: z.string() },
      annotations: { ...RO, title: "Open workspace" },
    },
    async ({ path }) =>
      invoke("open_workspace", { path }, async () => {
        const ws = await registry.open(path);
        return text(`Opened workspace ${ws.id}\nRoot: ${ws.root}`, {
          workspaceId: ws.id,
          root: ws.root,
        });
      }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List open workspaces",
      description: "List workspaces opened in this session.",
      inputSchema: {},
      outputSchema: {
        workspaces: z.array(z.object({ workspaceId: z.string(), root: z.string() })),
      },
      annotations: { ...RO, title: "List open workspaces" },
    },
    async () =>
      invoke("list_workspaces", {}, async () => {
        const list = registry.list().map((w) => ({ workspaceId: w.id, root: w.root }));
        return text(
          list.length ? list.map((w) => `${w.workspaceId}  ${w.root}`).join("\n") : "(none open)",
          { workspaces: list },
        );
      }),
  );

  // --- read ----------------------------------------------------------------

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 text file inside a workspace. Optionally a line range. " +
        "⚠ Do not open secret/credential files (.env, *.key, *.pem, tokens, credentials); " +
        "if a read is blocked or content is [redacted], stop and ask the user for the value.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().describe("workspace-relative file path"),
        offset: z.number().int().positive().optional().describe("1-based start line"),
        limit: z.number().int().positive().optional().describe("max lines to return"),
      },
      outputSchema: {
        path: z.string(),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
      },
      annotations: { ...RO, title: "Read file" },
    },
    async ({ workspaceId, path, offset, limit }) =>
      invoke("read_file", { workspaceId, path }, async () => {
        // Credential files are off-limits even inside an allowed root.
        if (secretGuard.isSecretPath(path)) return errorResult(secretGuard.blockMessage(path));
        const ws = registry.get(workspaceId);
        const r = await readFile(guard, ws, path, {
          maxBytes: config.maxReadBytes,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        // Re-check on the RESOLVED relative path: an innocuous name that
        // symlinks/resolves to a credential file must still be blocked.
        if (secretGuard.isSecretPath(r.path)) return errorResult(secretGuard.blockMessage(r.path));
        const header =
          `# ${r.path} (${r.bytes} bytes${r.truncated ? ", truncated" : ""}` +
          (r.returnedLines !== undefined ? `, lines ${offset ?? 1}..` : "") +
          `)\n`;
        if (r.notice) {
          return text(`${header}${r.notice}`, { path: r.path, bytes: r.bytes, truncated: r.truncated });
        }
        // Best-effort redaction of any secret-looking content we do return.
        const { text: body, redactions } = secretGuard.redact(r.text);
        const note = redactions ? `\n\n[devspace: ${redactions} secret value(s) redacted from this file]` : "";
        return text(`${header}\n${body}${note}`, {
          path: r.path,
          bytes: r.bytes,
          truncated: r.truncated,
        });
      }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List entries in a workspace directory (non-recursive).",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().optional().describe("workspace-relative dir (default: root)"),
      },
      outputSchema: {
        path: z.string(),
        entries: z.array(entrySchema),
        truncated: z.boolean(),
      },
      annotations: { ...RO, title: "List directory" },
    },
    async ({ workspaceId, path }) =>
      invoke("list_directory", { workspaceId, path: path ?? "." }, async () => {
        const ws = registry.get(workspaceId);
        const r = await listDirectory(guard, ws, path ?? ".");
        const dir = path && path !== "." ? path.replace(/\/+$/, "") + "/" : "";
        const body = r.entries
          .map((e) => {
            const icon = e.type === "directory" ? "📁" : e.type === "symlink" ? "🔗" : "  ";
            const locked = secretGuard.isSecretPath(dir + e.name) ? " 🔒 (secret — read blocked)" : "";
            return `${icon} ${e.name}${locked}`;
          })
          .join("\n");
        return text(`# ${r.path}${r.truncated ? " (truncated)" : ""}\n${body}`, {
          path: r.path,
          entries: r.entries,
          truncated: r.truncated,
        });
      }),
  );

  // --- search --------------------------------------------------------------

  server.registerTool(
    "find_files",
    {
      title: "Find files",
      description: "Find files by glob (e.g. **/*.ts). Symlink-safe; respects .gitignore by default.",
      inputSchema: {
        workspaceId: z.string(),
        glob: z.string().describe("workspace-relative glob, e.g. src/**/*.ts"),
        maxResults: z.number().int().positive().max(2000).optional(),
        includeDotfiles: z.boolean().optional(),
        respectGitignore: z.boolean().optional(),
      },
      outputSchema: {
        files: z.array(z.string()),
        truncated: z.boolean(),
      },
      annotations: { ...RO, title: "Find files" },
    },
    async ({ workspaceId, glob, maxResults, includeDotfiles, respectGitignore }) =>
      invoke("find_files", { workspaceId }, async () => {
        const ws = registry.get(workspaceId);
        const r = await findFiles(guard, ws, glob, {
          ...(maxResults !== undefined ? { maxResults } : {}),
          ...(includeDotfiles !== undefined ? { includeDotfiles } : {}),
          ...(respectGitignore !== undefined ? { respectGitignore } : {}),
          excludePath: (rel) => secretGuard.isSecretPath(rel),
        });
        return text(
          `${r.files.length} file(s)${r.truncated ? " (truncated)" : ""}\n${r.files.join("\n")}`,
          { files: r.files, truncated: r.truncated },
        );
      }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search file contents",
      description:
        "Search file contents (literal substring by default; set isRegex for a regex). Returns file:line matches. " +
        "Secret/credential files are excluded and secret-looking values are [redacted] — do not try to recover them.",
      inputSchema: {
        workspaceId: z.string(),
        query: z.string(),
        glob: z.string().optional().describe("limit to files matching this glob"),
        isRegex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().max(2000).optional(),
      },
      outputSchema: {
        matches: z.array(matchSchema),
        filesScanned: z.number().int().nonnegative(),
        truncated: z.boolean(),
      },
      annotations: { ...RO, title: "Search file contents" },
    },
    async ({ workspaceId, query, glob, isRegex, caseSensitive, maxResults }) =>
      invoke("search_files", { workspaceId }, async () => {
        const ws = registry.get(workspaceId);
        const r = await searchFiles(guard, ws, {
          query,
          maxResults: maxResults ?? config.maxSearchMatches,
          maxFileBytes: config.maxSearchFileBytes,
          ...(glob !== undefined ? { glob } : {}),
          ...(isRegex !== undefined ? { isRegex } : {}),
          ...(caseSensitive !== undefined ? { caseSensitive } : {}),
          excludePath: (rel) => secretGuard.isSecretPath(rel),
          redactLine: (line) => secretGuard.redact(line).text,
        });
        const body = r.matches.map((m) => `${m.file}:${m.lineNumber}: ${m.line}`).join("\n");
        return text(
          `${r.matches.length} match(es) in ${r.filesScanned} file(s)${r.truncated ? " (truncated)" : ""}\n${body}`,
          { matches: r.matches, filesScanned: r.filesScanned, truncated: r.truncated },
        );
      }),
  );

  // --- generated sites -----------------------------------------------------

  server.registerTool(
    "create_site",
    {
      title: "Create preview site",
      description:
        "Use this when the user wants a new live website preview. Creates a local versioned static site and returns a preview URL rendered in ChatGPT. " +
        SITE_DESIGN_DIRECTION,
      inputSchema: {
        title: z.string().min(1).max(120),
        prompt: z.string().min(1).max(4000).describe("User intent or design brief for this site."),
        archetype: z
          .enum(SITE_ARCHETYPES)
          .optional()
          .describe("Template archetype. Prefer this over custom html/css unless the user explicitly requests full custom code."),
        html: z
          .string()
          .optional()
          .describe("Full index.html. Must be complete, semantic, accessible HTML. If omitted, DevSpace creates a starter page."),
        css: z
          .string()
          .optional()
          .describe("Full styles.css. Use restrained, product-specific styling. If omitted, DevSpace creates starter styles."),
        js: z.string().optional().describe("Full script.js. If omitted, DevSpace creates a tiny starter script."),
      },
      outputSchema: siteDetailsSchema,
      annotations: { ...WRITE, title: "Create preview site" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Creating preview site",
        "openai/toolInvocation/invoked": "Preview site created",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ title, prompt, archetype, html, css, js }) =>
      invoke("create_site", { path: "devspace-sites" }, async () => {
        const site = await siteManager.createSite({ title, prompt, archetype, html, css, js });
        return sitePreviewResult(
          `Created ${site.title}\nPreview: ${site.previewUrl}\nVersion: ${site.latestVersion}`,
          site as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "update_site",
    {
      title: "Update preview site",
      description:
        "Use this when the user wants changes to an existing generated site. Writes provided full files and commits a new local version. " +
        SITE_DESIGN_DIRECTION,
      inputSchema: {
        siteId: z.string(),
        message: z.string().min(1).max(200).describe("Short git commit message describing the change."),
        title: z.string().min(1).max(120).optional(),
        html: z.string().optional().describe("New full index.html. Keep semantic structure complete. Omit to keep current file."),
        css: z.string().optional().describe("New full styles.css. Keep styling restrained and specific. Omit to keep current file."),
        js: z.string().optional().describe("New full script.js. Omit to keep current file."),
      },
      outputSchema: siteDetailsSchema,
      annotations: { ...WRITE, title: "Update preview site" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Updating preview site",
        "openai/toolInvocation/invoked": "Preview site updated",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ siteId, message, title, html, css, js }) =>
      invoke("update_site", { path: `devspace-sites/${siteId}` }, async () => {
        const site = await siteManager.updateSite({ siteId, message, title, html, css, js });
        return sitePreviewResult(
          `Updated ${site.title}\nPreview: ${site.previewUrl}\nVersion: ${site.latestVersion}`,
          site as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "list_sites",
    {
      title: "List preview sites",
      description: "Use this when the user asks which generated preview sites exist.",
      inputSchema: {},
      outputSchema: { sites: z.array(siteSummarySchema) },
      annotations: { ...RO, title: "List preview sites" },
    },
    async () =>
      invoke("list_sites", { path: "devspace-sites" }, async () => {
        const sites = await siteManager.listSites();
        const body = sites.length
          ? sites.map((s) => `${s.siteId}  ${s.title}  ${s.previewUrl}`).join("\n")
          : "(no generated sites)";
        return text(body, { sites });
      }),
  );

  server.registerTool(
    "get_site_versions",
    {
      title: "Get site versions",
      description: "Use this when the user asks for version history for a generated preview site.",
      inputSchema: { siteId: z.string() },
      outputSchema: {
        siteId: z.string(),
        title: z.string(),
        previewUrl: z.string(),
        latestVersion: z.string().nullable(),
        versions: z.array(siteVersionSchema),
        tags: z.array(siteTagSchema),
      },
      annotations: { ...RO, title: "Get site versions" },
    },
    async ({ siteId }) =>
      invoke("get_site_versions", { path: `devspace-sites/${siteId}` }, async () => {
        const site = await siteManager.getSite(siteId);
        const verBody = site.versions.length
          ? site.versions.map((v) => `${v.version.slice(0, 7)}  ${v.createdAt}  ${v.message}`).join("\n")
          : "(no versions)";
        const tagBody = site.tags.length
          ? "\n\nTags:\n" + site.tags.map((t) => `${t.tag} → ${t.version.slice(0, 7)}`).join("\n")
          : "";
        return text(verBody + tagBody, {
          siteId: site.siteId,
          title: site.title,
          previewUrl: site.previewUrl,
          latestVersion: site.latestVersion,
          versions: site.versions,
          tags: site.tags,
        });
      }),
  );

  // --- multi-file static projects (git-versioned, taggable) ----------------

  const projectFileSchema = z.object({
    path: z.string().min(1).max(400).describe("Project-relative path, e.g. index.html or pages/about.html"),
    content: z.string().describe("Full UTF-8 text content (pure static html/css/js/json/svg — no build runs)."),
  });

  server.registerTool(
    "create_project",
    {
      title: "Create static project",
      description:
        "Use this when the user wants a multi-file static website/project (multiple HTML pages, CSS, JS, assets). " +
        "Writes an arbitrary set of pure-static text files into a new local folder that is its own git repo, commits the " +
        "first version, and returns a preview URL rendered in ChatGPT. No build/install ever runs. " +
        SITE_DESIGN_DIRECTION,
      inputSchema: {
        title: z.string().min(1).max(120),
        files: z.array(projectFileSchema).min(1).max(200).describe("All files for the project. Include an index.html."),
        message: z.string().min(1).max(200).optional().describe("Initial git commit message."),
      },
      outputSchema: siteDetailsSchema,
      annotations: { ...WRITE, title: "Create static project" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Creating project",
        "openai/toolInvocation/invoked": "Project created",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ title, files, message }) =>
      invoke("create_project", { path: "projects" }, async () => {
        const site = await siteManager.createProject({ title, files, ...(message !== undefined ? { message } : {}) });
        return sitePreviewResult(
          `Created ${site.title} (${files.length} file(s))\nPreview: ${site.previewUrl}\nVersion: ${site.latestVersion}`,
          site as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update static project",
      description:
        "Use this when the user wants to change an existing static project. Writes the provided files (creating or " +
        "overwriting them), optionally deletes paths, and commits a new local version. No build/install ever runs. " +
        SITE_DESIGN_DIRECTION,
      inputSchema: {
        projectId: z.string().describe("The project id returned by create_project (same as siteId)."),
        message: z.string().min(1).max(200).describe("Short git commit message describing the change."),
        title: z.string().min(1).max(120).optional(),
        files: z.array(projectFileSchema).max(200).optional().describe("Files to create/overwrite. Omit to only delete."),
        deletions: z
          .array(z.string().min(1).max(400))
          .max(200)
          .optional()
          .describe("Project-relative paths to remove in this version."),
      },
      outputSchema: siteDetailsSchema,
      annotations: { ...WRITE, title: "Update static project" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Updating project",
        "openai/toolInvocation/invoked": "Project updated",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ projectId, message, title, files, deletions }) =>
      invoke("update_project", { path: `projects/${projectId}` }, async () => {
        const site = await siteManager.updateProject({
          siteId: projectId,
          message,
          ...(title !== undefined ? { title } : {}),
          ...(files !== undefined ? { files } : {}),
          ...(deletions !== undefined ? { deletions } : {}),
        });
        return sitePreviewResult(
          `Updated ${site.title}\nPreview: ${site.previewUrl}\nVersion: ${site.latestVersion}`,
          site as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "tag_version",
    {
      title: "Tag a project version",
      description:
        "Use this when the user wants to name/bookmark a specific version of a project (e.g. v1, release-2024). " +
        "Creates a git tag pointing at a commit (default: the latest). The tag can then be previewed via ?version=<tag>.",
      inputSchema: {
        projectId: z.string().describe("The project id (siteId)."),
        tag: z.string().min(1).max(64).describe("Tag name: letters/numbers/'.'/'_'/'-', not starting with '-' or '.'."),
        version: z
          .string()
          .optional()
          .describe("Commit hash or existing tag to point at. Defaults to the latest commit (HEAD)."),
        force: z.boolean().optional().describe("Move the tag if it already exists."),
      },
      outputSchema: siteDetailsSchema,
      annotations: { ...WRITE, title: "Tag a project version" },
    },
    async ({ projectId, tag, version, force }) =>
      invoke("tag_version", { path: `projects/${projectId}` }, async () => {
        const site = await siteManager.tagVersion({
          siteId: projectId,
          tag,
          ...(version !== undefined ? { version } : {}),
          ...(force !== undefined ? { force } : {}),
        });
        const tagLine = site.tags.map((t) => `${t.tag} → ${t.version.slice(0, 7)}`).join("\n") || "(no tags)";
        return text(`Tagged ${tag} on ${site.title}\n\nTags:\n${tagLine}`, site as unknown as Record<string, unknown>);
      }),
  );

  server.registerTool(
    "create_canvas_project",
    {
      title: "Create editable canvas project",
      description:
        "Create a versioned static project backed by structured canvas JSON and return an edit-session URL rendered in ChatGPT. " +
        "Use this when the user wants to directly drag, resize, and edit items on the preview canvas. " +
        "The browser editor can only save the bound scene/project for this session. " +
        "Do not use this when the user asks for OpenPencil, native design editing, or a Figma-like full editor; use openpencil_* tools instead.",
      inputSchema: {
        title: z.string().min(1).max(120),
        scene: canvasSceneSchema
          .optional()
          .describe("Optional initial structured canvas scene. Omit for a starter scene."),
        ttlSeconds: z
          .number()
          .int()
          .min(60)
          .max(604800)
          .optional()
          .describe("Edit session lifetime in seconds. Defaults to 24 hours."),
      },
      outputSchema: canvasProjectSchema,
      annotations: { ...WRITE, title: "Create editable canvas project" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Creating editable canvas",
        "openai/toolInvocation/invoked": "Editable canvas ready",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ title, scene, ttlSeconds }) =>
      invoke("create_canvas_project", { path: "projects" }, async () => {
        const project = await canvasSessions.createCanvasProject({
          title,
          ...(scene !== undefined ? { scene } : {}),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        });
        return sitePreviewResult(
          `Created editable canvas ${project.title}\nEdit: ${project.editUrl}\nPreview: ${project.sitePreviewUrl}\nVersion: ${project.latestVersion}`,
          project as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    "create_edit_session",
    {
      title: "Create canvas edit session",
      description:
        "Create an unguessable browser edit session for an existing canvas project. " +
        "The returned previewUrl opens the lightweight DevSpace editor; sitePreviewUrl is the normal read-only rendered project preview. " +
        "Do not use this for OpenPencil/native-editor workflows.",
      inputSchema: {
        projectId: z.string().describe("The project id returned by create_canvas_project or create_project."),
        title: z.string().min(1).max(120).optional(),
        scenePath: z
          .string()
          .min(1)
          .max(180)
          .optional()
          .describe("Project-relative JSON scene path. Defaults to scene.json."),
        ttlSeconds: z
          .number()
          .int()
          .min(60)
          .max(604800)
          .optional()
          .describe("Edit session lifetime in seconds. Defaults to 24 hours."),
      },
      outputSchema: editSessionSchema,
      annotations: { ...WRITE, title: "Create canvas edit session" },
      _meta: {
        "openai/outputTemplate": SITE_WIDGET_URI,
        "openai/toolInvocation/invoking": "Opening editable canvas",
        "openai/toolInvocation/invoked": "Editable canvas ready",
        ui: { resourceUri: SITE_WIDGET_URI },
      },
    },
    async ({ projectId, title, scenePath, ttlSeconds }) =>
      invoke("create_edit_session", { path: `projects/${projectId}` }, async () => {
        const session = await canvasSessions.createSession({
          siteId: projectId,
          ...(title !== undefined ? { title } : {}),
          ...(scenePath !== undefined ? { scenePath } : {}),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        });
        return sitePreviewResult(
          `Editable canvas session\nEdit: ${session.editUrl}\nPreview: ${session.sitePreviewUrl}\nExpires: ${session.expiresAt}`,
          session as unknown as Record<string, unknown>,
        );
      }),
  );

  // --- mutate --------------------------------------------------------------

  server.registerTool(
    "show_diff",
    {
      title: "Preview a write (diff)",
      description: "Compute the unified diff a write_file would produce, WITHOUT changing anything.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        content: z.string().describe("proposed new full file contents"),
      },
      outputSchema: { path: z.string(), exists: z.boolean() },
      annotations: { ...RO, title: "Preview a write (diff)" },
    },
    async ({ workspaceId, path, content }) =>
      invoke("show_diff", { workspaceId, path }, async () => {
        // show_diff reads the existing file into a diff — gate it like read_file
        // so it can't be used to exfiltrate a credential file's contents.
        if (secretGuard.isSecretPath(path)) return errorResult(secretGuard.blockMessage(path));
        const ws = registry.get(workspaceId);
        const r = await showDiff(guard, ws, path, content);
        if (secretGuard.isSecretPath(r.path)) return errorResult(secretGuard.blockMessage(r.path));
        return text(`# diff for ${r.path} (${r.exists ? "modify" : "create"})\n${secretGuard.redact(r.diff).text}`, {
          path: r.path,
          exists: r.exists,
        });
      }),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create or overwrite a file with full contents. Returns a diff. Set createOnly to refuse overwriting. " +
        "Only write files the user's current request needs. Before overwriting or deleting a file you did NOT " +
        "create this session, preview with show_diff and get explicit confirmation. Never write outside the workspace. " +
        OPENPENCIL_AUTHORING_GUIDANCE,
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        content: z.string(),
        createOnly: z.boolean().optional(),
      },
      outputSchema: {
        path: z.string(),
        created: z.boolean(),
        bytes: z.number().int().nonnegative(),
      },
      annotations: { ...WRITE, title: "Write file" },
    },
    async ({ workspaceId, path, content, createOnly }) =>
      invoke("write_file", { workspaceId, path }, async () => {
        const ws = registry.get(workspaceId);
        const r = await writeFile(guard, ws, path, content, {
          ...(createOnly !== undefined ? { createOnly } : {}),
        });
        return text(`${r.created ? "Created" : "Updated"} ${r.path} (${r.bytes} bytes)\n${r.diff}`, {
          path: r.path,
          created: r.created,
          bytes: r.bytes,
        });
      }),
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit file",
      description:
        "Apply exact-string replacements. Each oldText must occur exactly once unless replaceAll is set. Returns a diff. " +
        "Keep edits scoped to the user's request; don't make unrelated or destructive changes to files you didn't create. " +
        OPENPENCIL_AUTHORING_GUIDANCE,
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        edits: z
          .array(z.object({ oldText: z.string(), newText: z.string() }))
          .min(1)
          .describe("ordered list of exact oldText→newText replacements"),
        replaceAll: z.boolean().optional(),
      },
      outputSchema: {
        path: z.string(),
        bytes: z.number().int().nonnegative(),
      },
      annotations: { ...WRITE, title: "Edit file" },
    },
    async ({ workspaceId, path, edits, replaceAll }) =>
      invoke("edit_file", { workspaceId, path }, async () => {
        const ws = registry.get(workspaceId);
        const r = await editFile(guard, ws, path, edits, replaceAll ?? false);
        return text(`Edited ${r.path} (${r.bytes} bytes)\n${r.diff}`, { path: r.path, bytes: r.bytes });
      }),
  );

  // --- shell (opt-in) ------------------------------------------------------

  if (config.enablePackageInstall) {
    server.registerTool(
      "install_packages",
      {
        title: "Install packages",
        description:
          "Use this when a React/Next/Nx implementation needs third-party dependencies. " +
          "Infer the minimal package list from the user's task and the existing package.json; do not ask the user to enumerate packages manually. " +
          "The user reviews the package list in the ChatGPT tool approval UI before installation. " +
          "This is opt-in server-side and disables install scripts by default.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Workspace-relative package directory. Defaults to the workspace root."),
          reason: z
            .string()
            .min(1)
            .max(1000)
            .optional()
            .describe("Short explanation of why these packages are needed and how they will be used."),
          packages: z
            .array(z.string())
            .min(1)
            .max(30)
            .describe("npm package specs only, e.g. react, @scope/pkg, react@latest, react@18.2.0."),
          devDependency: z.boolean().optional().describe("Install as a devDependency."),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional().describe("Override auto-detection."),
        },
        outputSchema: {
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
          command: z.string(),
          args: z.array(z.string()),
          packages: z.array(z.string()),
          cwd: z.string(),
          exitCode: z.number().int().nullable(),
          signal: z.string().nullable(),
          timedOut: z.boolean(),
          truncated: z.boolean(),
          stdout: z.string(),
          stderr: z.string(),
          durationMs: z.number().int().nonnegative(),
        },
        annotations: { ...WRITE, title: "Install packages" },
      },
      async ({ workspaceId, path, reason, packages, devDependency, packageManager }) =>
        invoke("install_packages", { workspaceId, path: path ?? "." }, async () => {
          const ws = registry.get(workspaceId);
          const r = await installPackages(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            packages,
            ...(devDependency !== undefined ? { devDependency } : {}),
            ...(packageManager !== undefined ? { packageManager } : {}),
          });
          const status =
            r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`;
          const body =
            `Reason: ${reason ?? "Package installation requested"}\n$ ${r.command} ${r.args.join(" ")}\n[${status}${r.truncated ? ", output truncated" : ""}, ${r.durationMs}ms]\n` +
            (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
            (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
          return text(body, {
            packageManager: r.packageManager,
            command: r.command,
            args: r.args,
            packages: r.packages,
            cwd: r.cwd,
            exitCode: r.exitCode,
            signal: r.signal,
            timedOut: r.timedOut,
            truncated: r.truncated,
            stdout: r.stdout,
            stderr: r.stderr,
            durationMs: r.durationMs,
          });
        }),
    );
  }

  if (config.enableAppScaffold) {
    server.registerTool(
      "create_app",
      {
        title: "Create Nx app",
        description:
          "Use this when the user wants a real React or Next.js app. " +
          "Defaults to mode=isolated, which writes a clean Nx + Next workspace template under the opened workspace and avoids broken parent Nx graphs. Use mode=existing only for a healthy existing Nx monorepo. " +
          "Existing mode runs the workspace-local node_modules/.bin/nx with a fixed argv; isolated mode writes constrained template files. This never uses npx or an arbitrary shell command.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Workspace-relative base directory. Defaults to the workspace root."),
          appName: z.string().min(2).max(64).describe("Nx app name, e.g. ops-dashboard."),
          framework: z.enum(["next", "react"]).describe("Use next for Next.js app router projects, react for plain React apps. isolated mode currently supports next."),
          mode: z.enum(["existing", "isolated"]).optional().describe("Defaults to isolated. existing runs Nx generator in the target monorepo; isolated creates a clean Nx workspace folder."),
          directory: z.string().optional().describe("existing: Nx directory option, e.g. apps. isolated: parent folder for the new workspace, defaults to devspace-apps."),
          dryRun: z.boolean().optional().describe("Preview without writing files."),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional().describe("Override auto-detection."),
        },
        outputSchema: {
          appName: z.string(),
          framework: z.enum(["next", "react"]),
          mode: z.enum(["existing", "isolated"]),
          cwd: z.string(),
          workspaceRoot: z.string(),
          generatedFiles: z.array(z.string()),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
          command: z.string(),
          args: z.array(z.string()),
          exitCode: z.number().int().nullable(),
          signal: z.string().nullable(),
          timedOut: z.boolean(),
          truncated: z.boolean(),
          stdout: z.string(),
          stderr: z.string(),
          durationMs: z.number().int().nonnegative(),
        },
        annotations: { ...WRITE, title: "Create Nx app" },
      },
      async ({ workspaceId, path, appName, framework, mode, directory, dryRun, packageManager }) =>
        invoke("create_app", { workspaceId, path: path ?? "." }, async () => {
          const ws = registry.get(workspaceId);
          const r = await createApp(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            appName,
            framework,
            ...(mode !== undefined ? { mode } : {}),
            ...(directory !== undefined ? { directory } : {}),
            ...(dryRun !== undefined ? { dryRun } : {}),
            ...(packageManager !== undefined ? { packageManager } : {}),
          });
          const status =
            r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`;
          const body =
            `$ ${r.command} ${r.args.join(" ")}\n[${status}${r.truncated ? ", output truncated" : ""}, ${r.durationMs}ms]\n` +
            (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
            (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
          return text(body, {
            appName: r.appName,
            framework: r.framework,
            mode: r.mode,
            cwd: r.cwd,
            workspaceRoot: r.workspaceRoot,
            generatedFiles: r.generatedFiles,
            packageManager: r.packageManager,
            command: r.command,
            args: r.args,
            exitCode: r.exitCode,
            signal: r.signal,
            timedOut: r.timedOut,
            truncated: r.truncated,
            stdout: r.stdout,
            stderr: r.stderr,
            durationMs: r.durationMs,
          });
        }),
    );

    server.registerTool(
      "start_app_preview",
      {
        title: "Start app preview",
        description:
          "Use this when a generated Next/Nx app should be shown in ChatGPT. " +
          "Pass the workspace-relative or absolute path to the isolated app workspace returned by create_app. " +
          "This installs dependencies with lifecycle scripts disabled if needed, starts the workspace-local Nx dev server, and returns a preview URL rendered in ChatGPT.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Path to the isolated app workspace containing package.json and nx.json."),
          projectName: z.string().min(1).max(80).optional().describe("Nx project name. Defaults to package.json name."),
          install: z.boolean().optional().describe("Whether to run dependency install before starting. Defaults to true if node_modules/.bin/nx is missing."),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional().describe("Override auto-detection."),
          timeoutMs: z.number().int().min(10_000).max(300_000).optional().describe("Install/start readiness timeout."),
        },
        outputSchema: appPreviewSchema,
        annotations: { ...WRITE, title: "Start app preview" },
        _meta: {
          "openai/outputTemplate": SITE_WIDGET_URI,
          "openai/toolInvocation/invoking": "Starting app preview",
          "openai/toolInvocation/invoked": "App preview ready",
          ui: { resourceUri: SITE_WIDGET_URI },
        },
      },
      async ({ workspaceId, path, projectName, install, packageManager, timeoutMs }) =>
        invoke("start_app_preview", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          const preview = await appPreviewManager.start(ws, {
            path,
            ...(projectName !== undefined ? { projectName } : {}),
            ...(install !== undefined ? { install } : {}),
            ...(packageManager !== undefined ? { packageManager } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return previewResult(
            `Started ${preview.projectName}\nPreview: ${preview.previewUrl}\nLocal: ${preview.localUrl}`,
            {
              ...preview,
              siteId: preview.previewId,
              latestVersion: null,
            },
          );
        }),
    );
  }

  if (config.enableDesignExtract) {
    server.registerTool(
      "extract_design_reference",
      {
        title: "Extract design reference",
        description:
          "Load a PUBLIC reference page (real brand / successful product page) in a headless browser and extract its design language as concrete tokens — color palette, background colors, font families, type scale, font weights, spacing rhythm, border radii, and any CSS variables — plus a screenshot. " +
          "Use this in the Reference Audit / Foundations stage so the design is grounded in real references instead of guessed from memory. Treat the result as research: reuse tone/tokens/structure, do not copy logo/text/images/layout/brand. Only http(s) public URLs are allowed (private/loopback hosts are blocked).",
        inputSchema: {
          url: z.string().url().describe("Public http(s) URL of the reference page."),
          viewportWidth: z.number().int().min(320).max(3840).optional().describe("Viewport width (default 1440)."),
          fullPage: z.boolean().optional().describe("Capture the full scrollable page instead of the viewport."),
          timeoutMs: z.number().int().min(1000).max(60000).optional(),
        },
        outputSchema: {
          url: z.string(),
          finalUrl: z.string(),
          title: z.string(),
          colors: z.array(z.object({ color: z.string(), count: z.number() })),
          backgrounds: z.array(z.object({ color: z.string(), count: z.number() })),
          fontFamilies: z.array(z.string()),
          typeScale: z.array(z.number()),
          fontWeights: z.array(z.number()),
          spacing: z.array(z.number()),
          radii: z.array(z.number()),
          cssVariables: z.record(z.string()),
        },
        annotations: { ...RO, title: "Extract design reference", openWorldHint: true },
        _meta: {
          "openai/toolInvocation/invoking": "Extracting design reference",
          "openai/toolInvocation/invoked": "Design reference extracted",
        },
      },
      async ({ url, viewportWidth, fullPage, timeoutMs }) =>
        invoke("extract_design_reference", {}, async () => {
          let r;
          try {
            r = await extractDesignReference({
              url,
              ...(viewportWidth !== undefined ? { viewportWidth } : {}),
              ...(fullPage !== undefined ? { fullPage } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
          } catch (err) {
            if (err instanceof ExtractReferenceError) return errorResult(`extract_design_reference failed: ${err.message}`);
            throw err;
          }
          const summary =
            `Reference: ${r.title} (${r.finalUrl})\n` +
            `Colors: ${r.colors.map((c) => c.color).slice(0, 6).join(", ")}\n` +
            `Backgrounds: ${r.backgrounds.map((c) => c.color).slice(0, 4).join(", ")}\n` +
            `Fonts: ${r.fontFamilies.join(", ")} | type scale: ${r.typeScale.join("/")} | weights: ${r.fontWeights.join("/")}\n` +
            `Spacing: ${r.spacing.join("/")} | radii: ${r.radii.join("/")}` +
            (Object.keys(r.cssVariables).length ? `\nCSS vars: ${Object.keys(r.cssVariables).length} found` : "") +
            "\nResearch only — reuse tone/tokens/structure into 01 Reference Audit + 04 Foundations; do not copy the brand's assets.";
          const { screenshotBase64, ...structured } = r;
          return {
            content: [
              { type: "text", text: summary },
              { type: "image", data: screenshotBase64, mimeType: "image/png" },
            ],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }),
    );
  }

  if (config.enableOpenPencil) {
    server.registerTool(
      "openpencil_attach_preview",
      {
        title: "Attach OpenPencil preview",
        description:
          "Attach to an already-running OpenPencil local web/editor UI and render it inside the ChatGPT preview iframe. This read-only tool never starts OpenPencil, opens files, or writes files; use it when platform safety blocks app-launch actions.",
        inputSchema: {
          workspaceId: z.string(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: openPencilPreviewSchema,
        annotations: { ...RO, title: "Attach OpenPencil preview" },
        _meta: {
          "openai/outputTemplate": SITE_WIDGET_URI,
          "openai/toolInvocation/invoking": "Attaching OpenPencil preview",
          "openai/toolInvocation/invoked": "OpenPencil preview attached",
          ui: { resourceUri: SITE_WIDGET_URI },
        },
      },
      async ({ workspaceId, timeoutMs }) =>
        invoke("openpencil_attach_preview", { workspaceId }, async () => {
          registry.get(workspaceId);
          const preview = await openPencilPreviewManager.attach({
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return previewResult(
            `OpenPencil preview attached\nPreview: ${preview.previewUrl}\nLocal: ${preview.localUrl}`,
            {
              ...preview,
              siteId: preview.previewId,
              latestVersion: null,
            },
          );
        }),
    );

    server.registerTool(
      "openpencil_preview",
      {
        title: "Preview OpenPencil editor",
        description:
          "Start or attach to OpenPencil's local web/editor UI and render it inside the ChatGPT preview iframe through a DevSpace capability proxy. Use this when the user expects to manipulate OpenPencil directly inside ChatGPT preview.",
        inputSchema: {
          workspaceId: z.string(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: openPencilPreviewSchema,
        annotations: { ...WRITE, title: "Preview OpenPencil editor" },
        _meta: {
          "openai/outputTemplate": SITE_WIDGET_URI,
          "openai/toolInvocation/invoking": "Opening OpenPencil preview",
          "openai/toolInvocation/invoked": "OpenPencil preview ready",
          ui: { resourceUri: SITE_WIDGET_URI },
        },
      },
      async ({ workspaceId, timeoutMs }) =>
        invoke("openpencil_preview", { workspaceId }, async () => {
          registry.get(workspaceId);
          const preview = await openPencilPreviewManager.start({
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return previewResult(
            `OpenPencil preview ready\nPreview: ${preview.previewUrl}\nLocal: ${preview.localUrl}`,
            {
              ...preview,
              siteId: preview.previewId,
              latestVersion: null,
            },
          );
        }),
    );

    server.registerTool(
      "openpencil_status",
      {
        title: "OpenPencil status",
        description: "Check whether the configured OpenPencil app/CLI bridge is reachable.",
        inputSchema: {
          workspaceId: z.string(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: openPencilStatusSchema,
        annotations: { ...RO, title: "OpenPencil status" },
      },
      async ({ workspaceId, timeoutMs }) =>
        invoke("openpencil_status", { workspaceId }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilStatus(config, ws, timeoutMs);
          return text(
            `$ ${r.command} ${r.args.join(" ")}\n[${r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`}, ${r.durationMs}ms]\n` +
              (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
              (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""),
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_start",
      {
        title: "Start OpenPencil",
        description: "Start the configured OpenPencil desktop app through the operator-trusted `op` CLI.",
        inputSchema: {
          workspaceId: z.string(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Start OpenPencil" },
      },
      async ({ workspaceId, timeoutMs }) =>
        invoke("openpencil_start", { workspaceId }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilStart(config, ws, timeoutMs);
          return text(`$ ${r.command} ${r.args.join(" ")}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_open",
      {
        title: "Open OpenPencil file",
        description:
          "Open a guarded workspace .op file in the native OpenPencil app/editor. Use this before attach_preview when a specific document should be shown. " +
          OPENPENCIL_AUTHORING_GUIDANCE,
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative .op file path."),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Open OpenPencil file" },
      },
      async ({ workspaceId, path, timeoutMs }) =>
        invoke("openpencil_open", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilOpen(config, guard, ws, path, timeoutMs);
          return text(`Opened ${path}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_save",
      {
        title: "Save OpenPencil file",
        description:
          "Save the current OpenPencil canvas/document to a guarded workspace .op file. Use after the human edits in OpenPencil. " +
          "Prefer this over raw write_file/edit_file for .op output. " +
          "GATE: this refuses unless you have run openpencil_screenshot and visually reviewed the design at least once this session (pass force:true only to bypass after a deliberate human decision). " +
          OPENPENCIL_AUTHORING_GUIDANCE,
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative .op destination path."),
          force: z
            .boolean()
            .optional()
            .describe("Bypass the visual-review gate. Only set this when the user explicitly accepts saving without a screenshot review."),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Save OpenPencil file" },
      },
      async ({ workspaceId, path, force, timeoutMs }) =>
        invoke("openpencil_save", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          if (!force && !visualReviewedWorkspaces.has(workspaceId)) {
            return errorResult(
              "openpencil_save blocked by the visual-review gate: run openpencil_screenshot first and confirm the design looks correct (no overlap/clipping, section bars visible and colored, matrix cells filled, primary action clear, professional to a human). " +
                "Then call openpencil_save again, or pass force:true to bypass after a deliberate decision.",
            );
          }
          const r = await openPencilSave(config, guard, ws, path, timeoutMs);
          return text(`Saved ${path}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_design",
      {
        title: "Design in OpenPencil",
        description:
          "Use OpenPencil's native `op design - --file <path>` flow only when the user wants OpenPencil itself to apply a structured design operation. " +
          "This is not a generic JSON writer. Do not use it just to attach preview, inspect, or save current human edits. " +
          "The prompt is passed on stdin, never as argv or shell text. Follow with openpencil_get to validate and openpencil_open/openpencil_attach_preview for human editing. " +
          OPENPENCIL_AUTHORING_GUIDANCE,
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative .op file path to create or update."),
          prompt: z.string().min(1).max(200000).describe(
            "OpenPencil design instruction. Prefer concise, structured operation intent; do not paste raw invalid .op JSON.",
          ),
          canvasWidth: z.number().int().min(320).max(7680).optional(),
          postProcess: z.boolean().optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Design in OpenPencil" },
      },
      async ({ workspaceId, path, prompt, canvasWidth, postProcess, timeoutMs }) =>
        invoke("openpencil_design", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilDesign(config, guard, ws, {
            path,
            prompt,
            ...(canvasWidth !== undefined ? { canvasWidth } : {}),
            ...(postProcess !== undefined ? { postProcess } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Designed ${path}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_read_nodes",
      {
        title: "Read OpenPencil nodes",
        description:
          "Read native OpenPencil nodes from the live canvas or a guarded workspace .op file. Use this to inspect ids/parents before openpencil_update, openpencil_replace, or openpencil_delete.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to read the live OpenPencil canvas."),
          ids: z.array(z.string().min(1).max(200)).max(200).optional().describe("Optional node ids to read."),
          depth: z.number().int().min(0).max(50).optional(),
          vars: z.boolean().optional(),
          page: z.string().min(1).max(200).optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...RO, title: "Read OpenPencil nodes" },
      },
      async ({ workspaceId, path, ids, depth, vars, page, timeoutMs }) =>
        invoke("openpencil_read_nodes", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilReadNodes(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            ...(ids !== undefined ? { ids } : {}),
            ...(depth !== undefined ? { depth } : {}),
            ...(vars !== undefined ? { vars } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(
            `$ ${r.command} ${r.args.join(" ")}\n[${r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`}, ${r.durationMs}ms]\n` +
              (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
              (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""),
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_selection",
      {
        title: "Read OpenPencil selection",
        description: "Read the current OpenPencil live canvas selection, including selected node ids and active page.",
        inputSchema: {
          workspaceId: z.string(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...RO, title: "Read OpenPencil selection" },
      },
      async ({ workspaceId, timeoutMs }) =>
        invoke("openpencil_selection", { workspaceId }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilSelection(config, ws, timeoutMs);
          return text(
            `$ ${r.command} ${r.args.join(" ")}\n[${r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`}, ${r.durationMs}ms]\n` +
              (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
              (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""),
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_lint_design",
      {
        title: "Lint OpenPencil design",
        description:
          "Read the live canvas or a guarded .op file and run deterministic design-structure checks before saving or previewing. " +
          "This catches empty frames, full-frame backgrounds that cover content, tiny/empty text, generic layer names, and missing component organization. " +
          "If it returns errors, fix them with openpencil_move/openpencil_update/openpencil_insert before calling openpencil_save or attaching preview.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to lint the live OpenPencil canvas."),
          ids: z.array(z.string().min(1).max(200)).max(200).optional().describe("Optional root node ids to lint."),
          page: z.string().min(1).max(200).optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: openPencilLintSchema,
        annotations: { ...RO, title: "Lint OpenPencil design" },
      },
      async ({ workspaceId, path, ids, page, timeoutMs }) =>
        invoke("openpencil_lint_design", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilLintDesign(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            ...(ids !== undefined ? { ids } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          const issueText = r.issues.length
            ? r.issues.map((issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}${issue.fix ? ` Fix: ${issue.fix}` : ""}`).join("\n")
            : "No design lint issues.";
          return text(
            `OpenPencil design lint: ${r.ok ? "ok" : "failed"}\n` +
              `Frames: ${r.checkedFrames}; elements: ${r.visibleElementNodes}; text: ${r.visibleTextNodes}\n` +
              issueText,
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_screenshot",
      {
        title: "Screenshot OpenPencil design",
        description:
          "Render the live OpenPencil canvas or a guarded .op file (optionally a single frame by id) to a PNG and return it as an image so you can SEE the design and judge its visual quality before saving. " +
          "This is an approximate raster of the authored geometry (not a pixel-perfect editor capture), which faithfully reveals overlap, clipping, misalignment, missing/uncolored section bars, empty matrix cells, weak contrast, and crowding. " +
          "After it returns, LOOK at the image and score it: any overlap/clipping/misalignment? are the section bars visible and colored? are all state-matrix cells filled? is the primary action obvious (squint test)? does it look professional and good to a human, matching the agreed adjectives? " +
          "Fix problems with openpencil_update/openpencil_move and screenshot again. Running this unlocks the openpencil_save visual-review gate.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to screenshot the live OpenPencil canvas."),
          id: z.string().min(1).max(200).optional().describe("Optional node id to crop to (e.g. a single Screen or Section frame). Omit to render the whole canvas."),
          page: z.string().min(1).max(200).optional(),
          maxDimension: z.number().int().min(64).max(4096).optional().describe("Longest output edge in px; the render is scaled to fit. Default 1600."),
          background: z.string().min(1).max(32).optional().describe("Background color behind the design (default #FFFFFF)."),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: {
          targetId: z.string().nullable(),
          targetName: z.string().nullable(),
          width: z.number(),
          height: z.number(),
          byteLength: z.number(),
          nodeCount: z.number(),
        },
        annotations: { ...RO, title: "Screenshot OpenPencil design" },
        _meta: {
          "openai/toolInvocation/invoking": "Rendering OpenPencil screenshot",
          "openai/toolInvocation/invoked": "OpenPencil screenshot ready",
        },
      },
      async ({ workspaceId, path, id, page, maxDimension, background, timeoutMs }) =>
        invoke("openpencil_screenshot", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilScreenshot(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            ...(id !== undefined ? { id } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(maxDimension !== undefined ? { maxDimension } : {}),
            ...(background !== undefined ? { background } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          visualReviewedWorkspaces.add(workspaceId);
          const summary =
            `OpenPencil screenshot: ${r.targetName ?? "canvas"} — ${r.width}×${r.height}px, ${r.nodeCount} nodes.\n` +
            "Visually review now: any overlap, clipping, or misalignment? Are the section bars visible and COLORED? " +
            "Are all state-matrix cells filled? Is the primary action obvious? Does it look professional and good to a human? " +
            "Fix problems with openpencil_update/openpencil_move and screenshot again; only call openpencil_save once it looks right.";
          return {
            content: [
              { type: "text", text: summary },
              { type: "image", data: r.pngBase64, mimeType: "image/png" },
            ],
            structuredContent: {
              targetId: r.targetId,
              targetName: r.targetName,
              width: r.width,
              height: r.height,
              byteLength: r.byteLength,
              nodeCount: r.nodeCount,
            },
          };
        }),
    );

    server.registerTool(
      "openpencil_insert_section_band",
      {
        title: "Insert OpenPencil section band",
        description:
          "Author a complete, lint-clean colored section band directly into a guarded .op file — the reliable way to build a design package's '00 Brief … 10 Handoff' rail. " +
          "Prefer this over hand-building bands with openpencil_insert (op insert rejects string fills and `op insert --file` does not persist to the file). " +
          "It writes a 'Section / NN <Title>' frame with a full-width colored Banner BG as the last child, an Index Chip + Index Number, a white Section Title, and an optional Section Subtitle, using the harness category color for the index unless you override it. " +
          "Bands auto-stack down the page below existing 'Section /' frames unless you pass an explicit y. Call once per section (00..10), then openpencil_screenshot to review and openpencil_lint_design to verify.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative .op file to author the band into (created if missing)."),
          index: z.string().regex(/^\d{1,2}$/).describe('Section index, e.g. "00", "04", "07".'),
          title: z.string().min(1).max(200).describe('Section title, e.g. "Foundations".'),
          subtitle: z.string().max(400).optional().describe("Optional one-line purpose shown under the title."),
          color: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional().describe("Override the banner color (hex). Defaults to the category color for the index."),
          chipColor: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
          accentColor: z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i).optional(),
          x: z.number().int().min(-100000).max(100000).optional(),
          y: z.number().int().min(-100000).max(100000).optional().describe("Override the vertical position. Omit to auto-stack below existing bands."),
          width: z.number().int().min(200).max(7680).optional().describe("Band width (default 1200)."),
          height: z.number().int().min(48).max(400).optional().describe("Band height (default 96)."),
          page: z.string().min(1).max(200).optional(),
        },
        outputSchema: {
          nodeId: z.string(),
          name: z.string(),
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          color: z.string(),
          bandCount: z.number(),
        },
        annotations: { ...WRITE, title: "Insert OpenPencil section band" },
      },
      async ({ workspaceId, path, index, title, subtitle, color, chipColor, accentColor, x, y, width, height, page }) =>
        invoke("openpencil_insert_section_band", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilInsertSectionBand(config, guard, ws, {
            path,
            index,
            title,
            ...(subtitle !== undefined ? { subtitle } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(chipColor !== undefined ? { chipColor } : {}),
            ...(accentColor !== undefined ? { accentColor } : {}),
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(page !== undefined ? { page } : {}),
          });
          return text(
            `Inserted ${r.name} at y=${r.y} (${r.color}) into ${path}. Bands in file: ${r.bandCount}.\n` +
              "Add the other sections (00..10), then openpencil_screenshot to review and openpencil_lint_design to verify.",
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_insert_state_matrix",
      {
        title: "Insert OpenPencil state matrix",
        description:
          "Author a complete, lint-clean 'Section / 06 State Matrix' band directly into a guarded .op file: a colored banner, a 'Matrix / Header Row' of state columns, and one 'Matrix / Row / <component>' per component whose every 'Matrix Cell / <component> / <state>' holds a filled variant. " +
          "Prefer this over hand-building a matrix (it satisfies missing-state-matrix-headers and empty-state-cell by construction). Auto-stacks below existing 'Section /' bands unless you pass y.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().describe("Workspace-relative .op file to author the matrix into (created if missing)."),
          components: z.array(z.string().min(1).max(80)).min(1).max(30).describe('Component names, e.g. ["Button / Primary", "TextField"].'),
          states: z.array(z.string().min(1).max(40)).min(1).max(12).describe('State columns, e.g. ["Default","Hover","Focus","Disabled"].'),
          index: z.string().regex(/^\d{1,2}$/).optional().describe('Section index (default "06").'),
          title: z.string().min(1).max(200).optional().describe('Band title (default "State Matrix").'),
          subtitle: z.string().max(400).optional(),
          x: z.number().int().min(-100000).max(100000).optional(),
          y: z.number().int().min(-100000).max(100000).optional().describe("Override vertical position. Omit to auto-stack."),
          page: z.string().min(1).max(200).optional(),
        },
        outputSchema: {
          nodeId: z.string(),
          name: z.string(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          rows: z.number(),
          columns: z.number(),
          cells: z.number(),
        },
        annotations: { ...WRITE, title: "Insert OpenPencil state matrix" },
      },
      async ({ workspaceId, path, components, states, index, title, subtitle, x, y, page }) =>
        invoke("openpencil_insert_state_matrix", { workspaceId, path }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilInsertStateMatrix(config, guard, ws, {
            path,
            components,
            states,
            ...(index !== undefined ? { index } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(subtitle !== undefined ? { subtitle } : {}),
            ...(x !== undefined ? { x } : {}),
            ...(y !== undefined ? { y } : {}),
            ...(page !== undefined ? { page } : {}),
          });
          return text(
            `Inserted ${r.name} at y=${r.y}: ${r.rows} component(s) × ${r.columns} state(s) = ${r.cells} filled cells, into ${path}.\n` +
              "Then openpencil_screenshot to review and openpencil_lint_design to verify.",
            r as unknown as Record<string, unknown>,
          );
        }),
    );

    server.registerTool(
      "openpencil_insert",
      {
        title: "Insert OpenPencil node",
        description:
          "Insert a native OpenPencil node into the live canvas or a guarded .op file using `op insert`. Use this for AI-created design layers instead of raw write_file/edit_file. " +
          "Pass JSON node objects such as { type:'frame', name, x, y, width, height, fill, stroke, children } or text nodes with { type:'text', content, fontSize }. " +
          "The node JSON is passed on stdin, never argv. After inserting a full design, call openpencil_save and openpencil_read_nodes/openpencil_get to verify. " +
          OPENPENCIL_AUTHORING_GUIDANCE,
        inputSchema: {
          workspaceId: z.string(),
          node: z.unknown().describe("OpenPencil node JSON to insert. Prefer one frame containing child layers for a complete screen."),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to insert into the live OpenPencil canvas."),
          parent: z.string().min(1).max(200).optional(),
          index: z.number().int().min(0).max(100000).optional(),
          page: z.string().min(1).max(200).optional(),
          postProcess: z.boolean().optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Insert OpenPencil node" },
      },
      async ({ workspaceId, node, path, parent, index, page, postProcess, timeoutMs }) =>
        invoke("openpencil_insert", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilInsert(config, guard, ws, {
            node,
            ...(path !== undefined ? { path } : {}),
            ...(parent !== undefined ? { parent } : {}),
            ...(index !== undefined ? { index } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(postProcess !== undefined ? { postProcess } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Inserted OpenPencil node\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_update",
      {
        title: "Update OpenPencil node",
        description:
          "Patch native OpenPencil node fields by id using `op update`. Inspect ids with openpencil_read_nodes or openpencil_selection first. The JSON patch is passed on stdin, never argv.",
        inputSchema: {
          workspaceId: z.string(),
          id: z.string().min(1).max(200),
          patch: z.unknown().describe("Partial OpenPencil node JSON fields to update, e.g. { x, y, width, height, fill, content }."),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to update the live OpenPencil canvas."),
          page: z.string().min(1).max(200).optional(),
          postProcess: z.boolean().optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Update OpenPencil node" },
      },
      async ({ workspaceId, id, patch, path, page, postProcess, timeoutMs }) =>
        invoke("openpencil_update", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilUpdate(config, guard, ws, {
            id,
            patch,
            ...(path !== undefined ? { path } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(postProcess !== undefined ? { postProcess } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Updated OpenPencil node ${id}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_replace",
      {
        title: "Replace OpenPencil node",
        description:
          "Replace a native OpenPencil node by id using `op replace`. Use for substantial node rewrites after inspecting ids. The replacement node JSON is passed on stdin, never argv.",
        inputSchema: {
          workspaceId: z.string(),
          id: z.string().min(1).max(200),
          node: z.unknown().describe("Replacement OpenPencil node JSON."),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to replace in the live OpenPencil canvas."),
          page: z.string().min(1).max(200).optional(),
          postProcess: z.boolean().optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Replace OpenPencil node" },
      },
      async ({ workspaceId, id, node, path, page, postProcess, timeoutMs }) =>
        invoke("openpencil_replace", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilReplace(config, guard, ws, {
            id,
            node,
            ...(path !== undefined ? { path } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(postProcess !== undefined ? { postProcess } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Replaced OpenPencil node ${id}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_move",
      {
        title: "Move OpenPencil node",
        description:
          "Move a native OpenPencil node to a parent and optional index using `op move`. Use this to fix layer order/z-index or regroup nodes after inspecting ids with openpencil_read_nodes. " +
          "For full-frame background rectangles, move the background to the bottom layer if it covers visible UI.",
        inputSchema: {
          workspaceId: z.string(),
          id: z.string().min(1).max(200),
          parent: z.string().min(1).max(200),
          index: z.number().int().min(0).max(100000).optional(),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to move in the live OpenPencil canvas."),
          page: z.string().min(1).max(200).optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Move OpenPencil node" },
      },
      async ({ workspaceId, id, parent, index, path, page, timeoutMs }) =>
        invoke("openpencil_move", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilMove(config, guard, ws, {
            id,
            parent,
            ...(index !== undefined ? { index } : {}),
            ...(path !== undefined ? { path } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Moved OpenPencil node ${id}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_delete",
      {
        title: "Delete OpenPencil node",
        description:
          "Delete a native OpenPencil node by id using `op delete`. Inspect ids with openpencil_read_nodes or openpencil_selection first.",
        inputSchema: {
          workspaceId: z.string(),
          id: z.string().min(1).max(200),
          path: z.string().optional().describe("Optional workspace-relative .op file path. Omit to delete from the live OpenPencil canvas."),
          page: z.string().min(1).max(200).optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...WRITE, title: "Delete OpenPencil node" },
      },
      async ({ workspaceId, id, path, page, timeoutMs }) =>
        invoke("openpencil_delete", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilDelete(config, guard, ws, {
            id,
            ...(path !== undefined ? { path } : {}),
            ...(page !== undefined ? { page } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(`Deleted OpenPencil node ${id}\n[exit ${r.exitCode}, ${r.durationMs}ms]`, r as unknown as Record<string, unknown>);
        }),
    );

    server.registerTool(
      "openpencil_get",
      {
        title: "Inspect OpenPencil canvas",
        description:
          "Run OpenPencil's structured get command, optionally against a guarded workspace .op file. Use this after any .op write/save/design operation to verify OpenPencil can parse the result. " +
          OPENPENCIL_AUTHORING_GUIDANCE,
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Optional workspace-relative .op file path."),
          query: z.string().max(200).optional().describe("Optional OpenPencil get query, e.g. selection or canvas."),
          timeoutMs: z.number().int().min(1000).max(300000).optional(),
        },
        outputSchema: processResultSchema,
        annotations: { ...RO, title: "Inspect OpenPencil canvas" },
      },
      async ({ workspaceId, path, query, timeoutMs }) =>
        invoke("openpencil_get", { workspaceId, ...(path !== undefined ? { path } : {}) }, async () => {
          const ws = registry.get(workspaceId);
          const r = await openPencilGet(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            ...(query !== undefined ? { query } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          return text(
            `$ ${r.command} ${r.args.join(" ")}\n[${r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`}, ${r.durationMs}ms]\n` +
              (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
              (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""),
            r as unknown as Record<string, unknown>,
          );
        }),
    );
  }

  if (config.enableShell) {
    server.registerTool(
      "run_command",
      {
        title: "Run command (restricted)",
        description:
          config.shellMode === "restricted"
            ? "Run an allowlisted, read-only command (e.g. git status/diff/log) in a workspace. No shell; args are an array."
            : "Run a command in a workspace (UNRESTRICTED mode). No shell interpretation; pipes/redirection unsupported.",
        inputSchema: {
          workspaceId: z.string(),
          command: z.string().describe("bare binary name (no path), e.g. git"),
          args: z.array(z.string()).optional().describe("argument vector"),
        },
        outputSchema: {
          exitCode: z.number().int().nullable(),
          timedOut: z.boolean(),
          truncated: z.boolean(),
        },
        annotations: { ...WRITE, title: "Run command (restricted)" },
      },
      async ({ workspaceId, command, args }) =>
        invoke("run_command", { workspaceId }, async () => {
          const ws = registry.get(workspaceId);
          const r = await runCommand(config, ws, command, args ?? []);
          const status =
            r.timedOut ? "TIMED OUT" : r.signal ? `killed (${r.signal})` : `exit ${r.exitCode}`;
          const body =
            `$ ${command} ${(args ?? []).join(" ")}\n[${status}${r.truncated ? ", output truncated" : ""}, ${r.durationMs}ms]\n` +
            (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
            (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
          return text(body, {
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            truncated: r.truncated,
          });
        }),
    );
  }

  audit({ event: "server_start", detail: `tools registered (shell=${config.enableShell})` });
  return server;
}
