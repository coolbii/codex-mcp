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
import { WorkspaceRegistry } from "./workspaces.js";
import { SiteManager } from "./site-tools.js";
import { AppPreviewManager } from "./app-preview-tools.js";

export function makeApp(config: AppConfig, guard: PathGuard): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // cloudflared forwards requests from loopback and sets X-Forwarded-For.
  // Trust only loopback proxies so SDK rate-limiters can identify clients
  // without accepting spoofed forwarded headers from arbitrary networks.
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "8mb" }));

  const auth = buildAuth(config);
  const siteManager = new SiteManager(config, guard);
  const appPreviewManager = new AppPreviewManager(config, guard);
  app.locals.appPreviewManager = appPreviewManager;

  // Health check — unauthenticated, no sensitive info.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, name: "devspace", version: "0.1.0" });
  });

  // Discovery + (in oauth mode) the OAuth endpoints — unauthenticated, root.
  if (auth.router) {
    app.use(auth.router);
  }

  app.get(/^\/sites\/([^/]+)(?:\/(.*))?$/, async (req: Request, res: Response) => {
    try {
      const siteIdParam = req.params[0];
      const siteId = Array.isArray(siteIdParam) ? siteIdParam[0] : siteIdParam;
      if (!siteId) throw new Error("Missing site id");
      const pathParam = req.params[1];
      const path = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam ?? "");
      const version = typeof req.query.version === "string" ? req.query.version : undefined;
      const file = await siteManager.previewFile(siteId, path, version);
      res.type(file.contentType);
      res.setHeader("Cache-Control", version ? "public, max-age=31536000, immutable" : "no-store");
      res.sendFile(file.absolutePath);
    } catch (err) {
      const e = err as Error;
      res.status(404).type("text/plain").send(e.message);
    }
  });

  app.get(/^\/app-previews\/([^/]+)(?:\/(.*))?$/, async (req: Request, res: Response) => {
    try {
      const previewIdParam = req.params[0];
      const previewId = Array.isArray(previewIdParam) ? previewIdParam[0] : previewIdParam;
      if (!previewId) throw new Error("Missing preview id");
      const pathParam = req.params[1];
      const path = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam ?? "");
      await appPreviewManager.proxyPreview(previewId, req, res, path);
    } catch (err) {
      const e = err as Error;
      res.status(502).type("text/plain").send(e.message);
    }
  });

  app.get(/^\/_next\/(.*)$/, async (req: Request, res: Response) => {
    try {
      const pathParam = req.params[0];
      const path = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam ?? "");
      await appPreviewManager.proxyLatestAsset(req, res, path);
    } catch (err) {
      const e = err as Error;
      res.status(502).type("text/plain").send(e.message);
    }
  });

  // Edge Host/Origin guard for the MCP endpoint.
  app.use("/mcp", hostOriginGuard(config.allowedHosts, config.allowedOrigins));

  // One transport per session.
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // Shared across HTTP transport sessions. ChatGPT may open a workspace in one
  // session and invoke follow-up tools in another while reusing workspaceId.
  const registry = new WorkspaceRegistry(guard, config.allowedRoots);

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
      const server = buildMcpServer(config, guard, registry, appPreviewManager);
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
  const appPreviewManager = app.locals.appPreviewManager as AppPreviewManager | undefined;

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      const where = `http://${config.host}:${config.port}/mcp`;
      process.stderr.write(`\n[devspace] Streamable HTTP MCP listening on ${where}\n`);
      process.stderr.write(`[devspace] allowed roots:\n${config.allowedRoots.map((r) => `  - ${r}`).join("\n")}\n`);
      const authDesc = !config.requireAuth
        ? "DISABLED (loopback opt-out)"
        : config.authMode === "oauth"
          ? "OAuth 2.1 embedded AS (for ChatGPT) + owner token"
          : "owner bearer token REQUIRED";
      process.stderr.write(`[devspace] auth: ${authDesc}\n`);
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
    server.on("close", () => {
      appPreviewManager?.closeAll();
    });
  });
}
