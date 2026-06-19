/**
 * stdio.ts — stdio transport, for local MCP clients that spawn the server as a
 * subprocess (Claude Desktop, MCP Inspector, Cursor, etc.).
 *
 * stdout is the JSON-RPC channel. NOTHING may be written to stdout except the
 * protocol — all diagnostics go to stderr (see audit-log.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppConfig } from "./config.js";
import { PathGuard } from "./path-guard.js";
import { buildMcpServer } from "./mcp-server.js";

export async function startStdio(config: AppConfig): Promise<void> {
  const guard = new PathGuard(config.allowedRoots);
  const server = buildMcpServer(config, guard);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[devspace] stdio MCP ready. roots: ${config.allowedRoots.join(", ")} ` +
      `(shell=${config.enableShell ? config.shellMode : "disabled"})\n`,
  );
}
