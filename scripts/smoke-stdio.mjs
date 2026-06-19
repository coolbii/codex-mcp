/**
 * End-to-end smoke test against the stdio transport using the real MCP SDK
 * client. Spawns `node dist/bin/stdio.js`, opens a temp workspace, and exercises
 * list_roots → open_workspace → read_file, plus a traversal-escape that must
 * be rejected. Run from the project root after `npm run build`:
 *     node scripts/smoke-stdio.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const root = mkdtempSync(join(tmpdir(), "devspace-smoke-"));
writeFileSync(join(root, "hello.txt"), "line A\nline B\nNEEDLE here\n");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/bin/stdio.js"],
  env: { ...process.env, ALLOWED_ROOTS: root },
});
const client = new Client({ name: "smoke", version: "0" });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  assert(tools.includes("open_workspace") && tools.includes("read_file"));
  assert(!tools.includes("run_command"), "shell must be absent by default");

  const opened = await client.callTool({ name: "open_workspace", arguments: { path: root } });
  const wsId = opened.structuredContent?.workspaceId;
  console.log("workspaceId:", wsId);
  assert(wsId, "open_workspace returned no id");

  const read = await client.callTool({
    name: "read_file",
    arguments: { workspaceId: wsId, path: "hello.txt" },
  });
  console.log("read_file:", JSON.stringify(read.content[0].text.slice(0, 60)));
  assert(read.content[0].text.includes("NEEDLE"), "read_file did not return content");

  const search = await client.callTool({
    name: "search_files",
    arguments: { workspaceId: wsId, query: "NEEDLE" },
  });
  assert(search.structuredContent?.matches?.length === 1, "search did not find the needle");
  console.log("search_files matches:", search.structuredContent.matches.length);

  const escape = await client.callTool({
    name: "read_file",
    arguments: { workspaceId: wsId, path: "../../../../etc/hosts" },
  });
  console.log("escape isError:", escape.isError, "—", escape.content[0].text.slice(0, 70));
  assert(escape.isError === true, "traversal escape was NOT rejected!");

  console.log("\n✅ stdio end-to-end smoke passed");
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}
