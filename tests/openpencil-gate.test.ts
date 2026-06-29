import { afterEach, expect, it } from "vitest";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config.js";
import { WorkspaceRegistry } from "../src/workspaces.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { makeFixture, type Fixture } from "./helpers.js";

// Regression guard for the cross-session visual-review gate bug: ChatGPT's
// stateless tool calls each hit a fresh ephemeral McpServer, so the gate state
// MUST be a shared singleton passed into buildMcpServer (like the registry).
// When it was declared inside buildMcpServer, the screenshot that unlocked the
// gate on one server instance was invisible to the save on another -> save was
// always blocked. This test builds two instances sharing the gate and asserts a
// save on instance B respects an unlock applied via the shared set.

let fx: Fixture;
const silent = (): void => {};

afterEach(async () => {
  await fx?.cleanup();
});

async function fakeOp(): Promise<string> {
  const bin = join(fx.base, "op-gate-fake.mjs");
  await writeFile(
    bin,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const fi = args.indexOf("--file");
const file = fi >= 0 ? args[fi + 1] : (args[0] === "save" ? args[1] : undefined);
if (args[0] === "save" && file) { mkdirSync(file.split("/").slice(0, -1).join("/"), { recursive: true }); writeFileSync(file, "{}"); }
if (args[0] === "status") process.stdout.write("ok");
if (args[0] === "read-nodes") process.stdout.write(JSON.stringify({ nodes: [] }));
`,
    "utf8",
  );
  await chmod(bin, 0o755);
  return bin;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function contentText(result: unknown): string {
  return JSON.stringify((result as { content?: unknown })?.content ?? "");
}

it("shares the visual-review save gate across server instances", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: { ALLOWED_ROOTS: fx.root, OWNER_TOKEN: "x".repeat(40), ENABLE_OPENPENCIL: "1", OPENPENCIL_CLI: op },
    warn: silent,
  });
  const reviewed = new Set<string>();
  const registry = new WorkspaceRegistry(fx.guard, config.allowedRoots);
  // Two independent server instances sharing the registry + gate, exactly like the
  // per-request ephemeral servers in http.ts.
  const serverA = buildMcpServer(config, fx.guard, registry, undefined, undefined, undefined, reviewed);
  const serverB = buildMcpServer(config, fx.guard, registry, undefined, undefined, undefined, reviewed);
  const clientA = await connect(serverA);
  const clientB = await connect(serverB);

  const opened = await clientA.callTool({ name: "open_workspace", arguments: { path: fx.root } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string }).workspaceId;
  expect(workspaceId).toBeTruthy();

  // Save on B with no prior screenshot -> blocked by the shared gate.
  const blocked = await clientB.callTool({ name: "openpencil_save", arguments: { workspaceId, path: "designs/x.op" } });
  expect(blocked.isError).toBe(true);
  expect(contentText(blocked)).toMatch(/blocked by the visual-review gate/);

  // Simulate the screenshot unlock (what the screenshot handler does to the SHARED set).
  reviewed.add(workspaceId as string);

  // Save on B now succeeds -> proves B reads the shared gate, not a per-instance one.
  const ok = await clientB.callTool({ name: "openpencil_save", arguments: { workspaceId, path: "designs/x.op" } });
  expect(ok.isError).toBeFalsy();
  expect(contentText(ok)).toMatch(/Saved/);
});

it("lets force:true bypass the gate when no screenshot was taken", async () => {
  fx = await makeFixture();
  const op = await fakeOp();
  const config = loadConfig({
    transport: "http",
    env: { ALLOWED_ROOTS: fx.root, OWNER_TOKEN: "x".repeat(40), ENABLE_OPENPENCIL: "1", OPENPENCIL_CLI: op },
    warn: silent,
  });
  const reviewed = new Set<string>(); // stays empty: gate is locked
  const registry = new WorkspaceRegistry(fx.guard, config.allowedRoots);
  const server = buildMcpServer(config, fx.guard, registry, undefined, undefined, undefined, reviewed);
  const client = await connect(server);

  const opened = await client.callTool({ name: "open_workspace", arguments: { path: fx.root } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string }).workspaceId;

  const blocked = await client.callTool({ name: "openpencil_save", arguments: { workspaceId, path: "designs/y.op" } });
  expect(blocked.isError).toBe(true);

  const forced = await client.callTool({ name: "openpencil_save", arguments: { workspaceId, path: "designs/y.op", force: true } });
  expect(forced.isError).toBeFalsy();
  expect(contentText(forced)).toMatch(/Saved/);
});
