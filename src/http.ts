/**
 * http.ts — Streamable HTTP transport (for ChatGPT-via-tunnel and any remote
 * MCP client).
 *
 * Request pipeline for /mcp:
 *   1. hostOriginGuard  — edge DNS-rebinding / cross-origin defense
 *   2. requireAuth      — owner bearer token (or pass-through if disabled)
 *   3. session routing  — one StreamableHTTPServerTransport per mcp-session-id,
 *                         each bound to a fresh McpServer
 *
 * DNS-rebinding protection is enforced twice on purpose: our edge guard AND the
 * transport's own (deprecated-but-present) option. Belt and suspenders.
 */
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import { PathGuard } from "./path-guard.js";
import { buildMcpServer } from "./mcp-server.js";
import { buildAuth } from "./auth.js";
import { hostOriginGuard } from "./host-origin-guard.js";
import { audit } from "./audit-log.js";

export function makeApp(config: AppConfig, guard: PathGuard): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));

  const auth = buildAuth(config);

  // Health check — unauthenticated, no sensitive info.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, name: "devspace", version: "0.1.0" });
  });

  // OAuth discovery docs (unauthenticated) — only when auth is on.
  if (auth.metadataRouter) {
    app.use(auth.metadataRouter);
  }

  // Edge Host/Origin guard for the MCP endpoint.
  app.use("/mcp", hostOriginGuard(config.allowedHosts, config.allowedOrigins));

  // One transport per session.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", auth.requireAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport;
          audit({ event: "session_open", workspaceId: sid, success: true });
        },
        enableDnsRebindingProtection: config.enableDnsRebindingProtection,
        allowedHosts: config.allowedHosts,
        ...(config.allowedOrigins.length ? { allowedOrigins: config.allowedOrigins } : {}),
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          audit({ event: "session_close", workspaceId: sid, success: true });
        }
      };
      const server = buildMcpServer(config, guard);
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  app.get("/mcp", auth.requireAuth, sessionRequest);
  app.delete("/mcp", auth.requireAuth, sessionRequest);

  return app;
}

export function startHttp(config: AppConfig): Promise<Server> {
  const guard = new PathGuard(config.allowedRoots);
  const app = makeApp(config, guard);

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      const where = `http://${config.host}:${config.port}/mcp`;
      process.stderr.write(`\n[devspace] Streamable HTTP MCP listening on ${where}\n`);
      process.stderr.write(`[devspace] allowed roots:\n${config.allowedRoots.map((r) => `  - ${r}`).join("\n")}\n`);
      process.stderr.write(`[devspace] auth: ${config.requireAuth ? "owner bearer token REQUIRED" : "DISABLED (loopback opt-out)"}\n`);
      process.stderr.write(`[devspace] shell: ${config.enableShell ? config.shellMode : "disabled"}\n`);
      if (config.requireAuth && config.ownerTokenGenerated) {
        process.stderr.write(
          `\n[devspace] ⚠️  No OWNER_TOKEN set — generated an ephemeral one (changes on restart):\n` +
            `[devspace]     ${config.ownerToken}\n` +
            `[devspace]     Set OWNER_TOKEN in your environment to make it stable.\n`,
        );
      }
      if (config.publicBaseUrl) {
        process.stderr.write(`[devspace] public base URL: ${config.publicBaseUrl}\n`);
      }
      process.stderr.write("\n");
      audit({ event: "server_start", detail: where, success: true });
      resolve(server);
    });
  });
}
