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
import { audit } from "./audit-log.js";
import { SiteManager, SITE_ARCHETYPES } from "./site-tools.js";

const SERVER_NAME = "devspace";
const SERVER_VERSION = "0.1.0";
const SITE_WIDGET_URI = "ui://devspace/site-preview.v3.html";
const SITE_WIDGET_URI_ALIASES = [
  SITE_WIDGET_URI,
  "ui://devspace/site-preview.v2.html",
  "ui://devspace/site-preview.html",
] as const;
const SITE_WIDGET_MIME = "text/html;profile=mcp-app";
const SITE_DESIGN_DIRECTION =
  "Generated sites should feel hand-designed, restrained, and domain-specific. " +
  "Avoid generic AI SaaS styling: no decorative gradient blobs/orbs, no fake dashboard screenshots, " +
  "no over-rounded card stacks, no purple-blue one-note palettes, no vague feature copy, and no oversized hero unless the brief requires it. " +
  "Prefer quiet typography, clear hierarchy, compact sections, restrained color, real content structure, accessible contrast, " +
  "8px-or-less radii, stable responsive layout, and complete HTML/CSS/JS files. " +
  "Prefer choosing an archetype and omitting raw html/css unless the user explicitly asks for custom code.";

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
      iframe { display: block; width: 100%; height: calc(100vh - 49px); border: 0; background: white; }
      .empty { display: grid; min-height: 220px; place-items: center; color: #9aa4b2; padding: 24px; text-align: center; }
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
        "For create_site and update_site: " +
        SITE_DESIGN_DIRECTION,
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
  const siteManager = new SiteManager(config, guard);
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
      description: "Read a UTF-8 text file inside a workspace. Optionally a line range.",
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
        const ws = registry.get(workspaceId);
        const r = await readFile(guard, ws, path, {
          maxBytes: config.maxReadBytes,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const header =
          `# ${r.path} (${r.bytes} bytes${r.truncated ? ", truncated" : ""}` +
          (r.returnedLines !== undefined ? `, lines ${offset ?? 1}..` : "") +
          `)\n`;
        return text(r.notice ? `${header}${r.notice}` : `${header}\n${r.text}`, {
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
        const body = r.entries
          .map((e) => `${e.type === "directory" ? "📁" : e.type === "symlink" ? "🔗" : "  "} ${e.name}`)
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
        "Search file contents (literal substring by default; set isRegex for a regex). Returns file:line matches.",
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
      },
      annotations: { ...RO, title: "Get site versions" },
    },
    async ({ siteId }) =>
      invoke("get_site_versions", { path: `devspace-sites/${siteId}` }, async () => {
        const site = await siteManager.getSite(siteId);
        const body = site.versions.length
          ? site.versions.map((v) => `${v.version.slice(0, 7)}  ${v.createdAt}  ${v.message}`).join("\n")
          : "(no versions)";
        return text(body, {
          siteId: site.siteId,
          title: site.title,
          previewUrl: site.previewUrl,
          latestVersion: site.latestVersion,
          versions: site.versions,
        });
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
        const ws = registry.get(workspaceId);
        const r = await showDiff(guard, ws, path, content);
        return text(`# diff for ${r.path} (${r.exists ? "modify" : "create"})\n${r.diff}`, {
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
        "Create or overwrite a file with full contents. Returns a diff. Set createOnly to refuse overwriting.",
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
        "Apply exact-string replacements. Each oldText must occur exactly once unless replaceAll is set. Returns a diff.",
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
          args: z.array(z.string()),
          packages: z.array(z.string()),
          cwd: z.string(),
          exitCode: z.number().int().nullable(),
          timedOut: z.boolean(),
          truncated: z.boolean(),
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
            `Reason: ${reason ?? "Package installation requested"}\n$ ${r.packageManager} ${r.args.join(" ")}\n[${status}${r.truncated ? ", output truncated" : ""}, ${r.durationMs}ms]\n` +
            (r.stdout ? `\n--- stdout ---\n${r.stdout}` : "") +
            (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
          return text(body, {
            packageManager: r.packageManager,
            args: r.args,
            packages: r.packages,
            cwd: r.cwd,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            truncated: r.truncated,
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
          "Use this when the user wants a real React or Next.js app scaffolded inside an existing Nx monorepo. " +
          "Open the Nx workspace first, inspect package.json/nx.json, then call this with a concise appName. " +
          "This runs the workspace-local node_modules/.bin/nx with a fixed argv, not npx or an arbitrary shell command.",
        inputSchema: {
          workspaceId: z.string(),
          path: z.string().optional().describe("Workspace-relative Nx monorepo directory. Defaults to the workspace root."),
          appName: z.string().min(2).max(64).describe("Nx app name, e.g. ops-dashboard."),
          framework: z.enum(["next", "react"]).describe("Use next for Next.js app router projects, react for plain React apps."),
          directory: z.string().optional().describe("Optional safe Nx directory option, e.g. apps or products/admin."),
          dryRun: z.boolean().optional().describe("Preview the Nx generator without writing files."),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).optional().describe("Override auto-detection."),
        },
        outputSchema: {
          appName: z.string(),
          framework: z.enum(["next", "react"]),
          cwd: z.string(),
          packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]),
          command: z.string(),
          args: z.array(z.string()),
          exitCode: z.number().int().nullable(),
          timedOut: z.boolean(),
          truncated: z.boolean(),
        },
        annotations: { ...WRITE, title: "Create Nx app" },
      },
      async ({ workspaceId, path, appName, framework, directory, dryRun, packageManager }) =>
        invoke("create_app", { workspaceId, path: path ?? "." }, async () => {
          const ws = registry.get(workspaceId);
          const r = await createApp(config, guard, ws, {
            ...(path !== undefined ? { path } : {}),
            appName,
            framework,
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
            cwd: r.cwd,
            packageManager: r.packageManager,
            command: r.command,
            args: r.args,
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            truncated: r.truncated,
          });
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
