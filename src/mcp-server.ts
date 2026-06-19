/**
 * mcp-server.ts — wire the pure primitives to MCP tools.
 *
 * One McpServer is built per session (HTTP) or once (stdio). Each gets its own
 * WorkspaceRegistry so sessions cannot see each other's open workspaces. The
 * PathGuard and AppConfig are shared (immutable).
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
import { audit } from "./audit-log.js";

const SERVER_NAME = "devspace";
const SERVER_VERSION = "0.1.0";

function text(s: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: s }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function buildMcpServer(config: AppConfig, guard: PathGuard): McpServer {
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
        "(exact oldText→newText replacement). All paths are workspace-relative.",
    },
  );

  // Per-session registry.
  const registry = new WorkspaceRegistry(guard, config.allowedRoots);

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

  // --- discovery -----------------------------------------------------------

  server.registerTool(
    "list_roots",
    {
      title: "List allowed roots",
      description: "List the directories this server is permitted to open.",
      inputSchema: {},
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
