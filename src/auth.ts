/**
 * auth.ts — authentication wiring, with two modes.
 *
 * AUTH_MODE=owner_token (default): a static owner bearer token compared in
 * constant time, wrapped in the SDK's spec machinery so an unauthenticated /mcp
 * request returns 401 + `WWW-Authenticate: Bearer …, resource_metadata="…"` and
 * `/.well-known/oauth-protected-resource` is served. Works for local clients
 * (Claude Desktop / Inspector / curl) — but NOT ChatGPT (its connector can't send
 * a custom Authorization header).
 *
 * AUTH_MODE=oauth: an embedded OAuth 2.1 authorization server (see
 * oauth-provider.ts) mounted via the SDK's `mcpAuthRouter`. This is what lets
 * ChatGPT web connect (DCR + PKCE; the OWNER_TOKEN is the login password). The
 * owner token is ALSO still accepted as a bearer in this mode, so local clients
 * keep working.
 */
import { timingSafeEqual } from "node:crypto";
import {
  mcpAuthRouter,
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Router, type RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import { DevspaceOAuthProvider } from "./oauth-provider.js";
import { audit } from "./audit-log.js";

export interface AuthBundle {
  /** Unauthenticated discovery / OAuth routes, mounted at app root. null = none. */
  router: RequestHandler | null;
  /** Gate to apply to every /mcp method. Pass-through when auth disabled. */
  requireAuth: RequestHandler;
  /** Canonical resource URL of this server (origin + /mcp). */
  resourceUrl: URL;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function buildAuth(config: AppConfig): AuthBundle {
  const base = config.publicBaseUrl ?? `http://${config.host}:${config.port}`;
  const resourceUrl = new URL("/mcp", base);
  const issuerUrl = new URL(base);

  if (!config.requireAuth) {
    const passThrough: RequestHandler = (_req, _res, next) => next();
    return { router: null, requireAuth: passThrough, resourceUrl };
  }

  // -------- AUTH_MODE=oauth : embedded OAuth 2.1 AS (for ChatGPT) --------
  if (config.authMode === "oauth") {
    const provider = new DevspaceOAuthProvider(config, resourceUrl, issuerUrl);
    const oauthRouter = mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ["mcp"],
      resourceName: "DevSpace self-hosted filesystem MCP",
    });
    const root = Router();
    root.use(provider.loginRouter()); // POST /oauth/login (owner-password submit)
    root.use(oauthRouter); // well-knowns + /authorize + /token + /register + /revoke

    const requireAuth = requireBearerAuth({
      verifier: provider, // verifyAccessToken accepts OAuth tokens AND the owner token
      requiredScopes: ["mcp"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    });
    return { router: root, requireAuth, resourceUrl };
  }

  // -------- AUTH_MODE=owner_token : static bearer token (default) --------
  const ownerToken = config.ownerToken;
  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (!constantTimeEqual(token, ownerToken)) {
        audit({ event: "auth_fail", success: false, detail: "bad_token" });
        throw new Error("invalid_token");
      }
      audit({ event: "auth_ok", success: true });
      return {
        token,
        clientId: "owner",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: resourceUrl,
      };
    },
  };

  // In owner-token mode we do not run /authorize or /token; clients that try the
  // full OAuth dance fail closed (correct — only a pasted bearer token works).
  const oauthMetadata: OAuthMetadata = {
    issuer: resourceUrl.origin,
    authorization_endpoint: `${resourceUrl.origin}/authorize`,
    token_endpoint: `${resourceUrl.origin}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  };
  const metadataRouter = mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl: resourceUrl,
    resourceName: "DevSpace self-hosted filesystem MCP",
    scopesSupported: ["mcp"],
  });
  const requireAuth = requireBearerAuth({
    verifier,
    requiredScopes: ["mcp"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
  return { router: metadataRouter, requireAuth, resourceUrl };
}
