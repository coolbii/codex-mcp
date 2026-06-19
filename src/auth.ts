/**
 * auth.ts — owner-token authentication, shaped like OAuth discovery.
 *
 * DECISION (see docs/security.md §Auth): for a single-user server the simplest
 * *correct* design is a static owner bearer token compared in constant time,
 * wrapped in the SDK's spec machinery so that:
 *   - an unauthenticated /mcp request returns 401 with a
 *     `WWW-Authenticate: Bearer …, resource_metadata="…"` challenge, and
 *   - `/.well-known/oauth-protected-resource[/mcp]` is served, so a discovering
 *     client behaves correctly.
 *
 * INTEROP CAVEAT (verified during research): ChatGPT Developer Mode offers only
 * OAuth / No-auth / Mixed and cannot reliably send a custom Authorization
 * header, so the owner-token path works for local clients (Claude Desktop, the
 * MCP Inspector, curl) but NOT for ChatGPT. Connecting ChatGPT requires the
 * OAuth 2.1 + PKCE proxy milestone (ProxyOAuthServerProvider + mcpAuthRouter).
 * This module is structured so that path slots in beside it later.
 */
import { timingSafeEqual } from "node:crypto";
import {
  mcpAuthMetadataRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RequestHandler, Router } from "express";
import type { AppConfig } from "./config.js";
import { audit } from "./audit-log.js";

export interface AuthBundle {
  /** OAuth discovery docs (unauthenticated). null when auth is disabled. */
  metadataRouter: Router | null;
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

  if (!config.requireAuth) {
    const passThrough: RequestHandler = (_req, _res, next) => next();
    return { metadataRouter: null, requireAuth: passThrough, resourceUrl };
  }

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
        // Sliding 1h window. A static token re-verifies every request, so it
        // never actually expires — but the field is required to be honoured.
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: resourceUrl,
      };
    },
  };

  // Advertised authorization-server metadata. In owner-token mode we do not run
  // an /authorize or /token endpoint; clients that attempt the full OAuth dance
  // fail closed (which is correct — only a pasted bearer token works here).
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

  return { metadataRouter, requireAuth, resourceUrl };
}
