/**
 * oauth-provider.ts — an embedded, single-user OAuth 2.1 authorization server.
 *
 * This is what lets ChatGPT web connect (ChatGPT's connector only speaks OAuth,
 * never a pasted token). The SDK's `mcpAuthRouter` mounts the standard endpoints
 * (well-knowns, /authorize, /token, /register, /revoke) and delegates the actual
 * logic to this provider.
 *
 * Design choices (all deliberate, all security-relevant):
 *   - **DCR**: clients (ChatGPT) self-register via /register; we never hardcode a
 *     client_id or redirect_uri — we accept and persist whatever ChatGPT sends.
 *     The SDK validates redirect_uri against the registered set before calling
 *     authorize(), so open-redirect is structurally prevented.
 *   - **PKCE S256**: required. The SDK's /token handler verifies the verifier
 *     against the code_challenge we return from challengeForAuthorizationCode().
 *   - **Owner-password login**: authorize() renders a tiny login page; the
 *     operator types the OWNER_TOKEN (constant-time compared). Only then is an
 *     auth code minted. The authorization context lives server-side keyed by an
 *     opaque high-entropy ticket — the browser only ever holds the ticket, so it
 *     cannot tamper with client_id / redirect_uri / code_challenge.
 *   - **Opaque tokens** (not JWT) to avoid signing pitfalls. Access codes/tokens
 *     are single-purpose, short-TTL, single-use where applicable.
 *   - **Persistence**: clients + refresh/access tokens hit disk (0600), so a
 *     restart doesn't make ChatGPT's current bearer token immediately fail.
 *     Auth codes and pending logins remain in-memory and short-lived.
 *   - **Owner token still works** as a bearer in oauth mode (for curl/Inspector).
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Router, urlencoded, type Request, type Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "./config.js";
import { audit } from "./audit-log.js";

const ACCESS_TTL_SEC = 24 * 3600;
const CODE_TTL_MS = 60_000;
const TICKET_TTL_MS = 10 * 60_000;
// Brute-force defense for the owner-password login.
const MAX_TICKET_ATTEMPTS = 5; // wrong guesses before a ticket is burned
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_PER_SOURCE = 20; // login POSTs per source per window
// Bound the persisted DCR client set (open /register over the tunnel).
const MAX_CLIENTS = 1000;

interface AuthContext {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number; // ms epoch
  attempts: number; // wrong-password guesses against this ticket
}
interface AccessInfo {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number; // ms epoch
}
interface RefreshInfo {
  clientId: string;
  scopes: string[];
  resource: string;
}
interface PersistShape {
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshInfo>;
  accessTokens?: Record<string, AccessInfo>;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function ctEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

export class DevspaceOAuthProvider implements OAuthServerProvider {
  // Persisted to disk.
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly refreshTokens = new Map<string, RefreshInfo>();
  private readonly accessTokens = new Map<string, AccessInfo>(); // token -> info
  // In-memory only (safe to lose on restart).
  private readonly pending = new Map<string, AuthContext>(); // ticket -> ctx
  private readonly completed = new Map<string, AuthContext>(); // ticket -> ctx, for duplicate form submits
  private readonly codes = new Map<string, AuthContext>(); // code -> ctx
  private readonly loginHits = new Map<string, { count: number; resetAt: number }>(); // source -> rate window

  constructor(
    private readonly config: AppConfig,
    /** Canonical protected-resource URL, e.g. https://tunnel/mcp */
    private readonly resourceUrl: URL,
  ) {
    this.load();
  }

  // -------------------------------------------------------------- persistence
  private load(): void {
    try {
      if (!existsSync(this.config.oauthStorePath)) return;
      const data = JSON.parse(readFileSync(this.config.oauthStorePath, "utf8")) as PersistShape;
      for (const [id, c] of Object.entries(data.clients ?? {})) this.clients.set(id, c);
      for (const [t, r] of Object.entries(data.refreshTokens ?? {})) this.refreshTokens.set(t, r);
      const now = Date.now();
      for (const [t, a] of Object.entries(data.accessTokens ?? {})) {
        if (a.expiresAt > now) this.accessTokens.set(t, a);
      }
    } catch {
      audit({ event: "server_start", success: false, detail: "oauth store unreadable; starting empty" });
    }
  }

  private persist(): void {
    const data: PersistShape = {
      clients: Object.fromEntries(this.clients),
      refreshTokens: Object.fromEntries(this.refreshTokens),
      accessTokens: Object.fromEntries(this.accessTokens),
    };
    const dir = dirname(this.config.oauthStorePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.oauth.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.config.oauthStorePath);
  }

  // ------------------------------------------------------------- clients (DCR)
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        const partial = client as Partial<OAuthClientInformationFull>;
        const full: OAuthClientInformationFull = {
          ...(client as OAuthClientInformationFull),
          client_id: partial.client_id ?? randomUUID(),
          client_id_issued_at: partial.client_id_issued_at ?? Math.floor(Date.now() / 1000),
        };
        // Bound the store: /register is open over the tunnel. Evict the oldest
        // client so an attacker cannot grow the persisted file without limit.
        if (this.clients.size >= MAX_CLIENTS) {
          let oldestId: string | undefined;
          let oldestAt = Infinity;
          for (const [id, c] of this.clients) {
            const issued = c.client_id_issued_at ?? 0;
            if (issued < oldestAt) {
              oldestAt = issued;
              oldestId = id;
            }
          }
          if (oldestId) this.clients.delete(oldestId);
        }
        this.clients.set(full.client_id, full);
        this.persist();
        audit({
          event: "auth_ok",
          success: true,
          detail: `oauth client registered (${full.redirect_uris?.length ?? 0} redirect_uris)`,
        });
        return full;
      },
    };
  }

  // ------------------------------------------------------ authorize (login UI)
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.pruneExpired();
    audit({
      event: "auth_ok",
      success: true,
      detail: `oauth authorize start; redirect=${new URL(params.redirectUri).origin}${new URL(params.redirectUri).pathname}; resource=${(params.resource ?? this.resourceUrl).toString()}`,
    });
    const ticket = newToken();
    this.pending.set(ticket, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      ...(params.state !== undefined ? { state: params.state } : {}),
      scopes: params.scopes && params.scopes.length ? params.scopes : ["mcp"],
      resource: (params.resource ?? this.resourceUrl).toString(),
      expiresAt: Date.now() + TICKET_TTL_MS,
      attempts: 0,
    });
    this.sendSecureHtml(res, 200, this.loginPage(ticket, client, false));
  }

  /** The owner-password login form. The page only carries an opaque ticket. */
  private loginPage(ticket: string, client: OAuthClientInformationFull, error: boolean): string {
    const name = escapeHtml(client.client_name ?? client.client_id ?? "an application");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>DevSpace · Authorize</title>
<style>
  :root{color-scheme:dark light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e1116;color:#e6edf3}
  .card{width:min(92vw,400px);background:#161b22;border:1px solid #30363d;border-radius:14px;padding:28px}
  h1{font-size:18px;margin:0 0 4px}
  p{color:#8b949e;margin:0 0 18px;font-size:13px}
  b{color:#e6edf3}
  label{display:block;font-size:12px;color:#8b949e;margin:0 0 6px}
  input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:14px}
  input:focus{outline:none;border-color:#388bfd;box-shadow:0 0 0 3px #388bfd33}
  button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:9px;background:#238636;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#2ea043}
  .err{color:#f85149;font-size:13px;margin:12px 0 0}
  .hint{margin-top:14px;font-size:11px;color:#6e7681}
</style></head><body><main class="card">
<h1>Authorize DevSpace</h1>
<p><b>${name}</b> is requesting access to your sandboxed local workspace.</p>
<form method="POST" action="/oauth/login" autocomplete="off">
  <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
  <label for="pw">Owner password (your OWNER_TOKEN)</label>
  <input id="pw" type="password" name="password" autofocus required>
  ${error ? '<p class="err">Incorrect password. Try again.</p>' : ""}
  <button type="submit">Authorize</button>
</form>
<p class="hint">Only authorize if you started this from your own ChatGPT connector.</p>
</main></body></html>`;
  }

  private errorPage(msg: string): string {
    return `<!doctype html><meta charset="utf-8"><title>DevSpace</title>
<body style="font-family:-apple-system,sans-serif;background:#0e1116;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0">
<p style="max-width:420px;text-align:center">${escapeHtml(msg)}</p></body>`;
  }

  private redirectPage(url: string): string {
    const safeUrl = escapeHtml(url);
    const jsUrl = JSON.stringify(url).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${safeUrl}">
<title>DevSpace · Redirecting</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e1116;color:#e6edf3}
  main{max-width:460px;text-align:center;padding:24px}
  a{color:#58a6ff}
</style></head><body><main>
<p>Returning to ChatGPT...</p>
<p><a id="continue" href="${safeUrl}" rel="noreferrer">Continue to ChatGPT</a></p>
<script>window.location.replace(${jsUrl});</script>
</main></body></html>`;
  }

  /** Send an auth HTML page with strict anti-clickjacking / no-cache headers. */
  private sendSecureHtml(res: Response, status: number, html: string): void {
    res.status(status);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.send(html);
  }

  private sendRedirectHtml(res: Response, url: string): void {
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.send(this.redirectPage(url));
  }

  /** Fixed-window per-source rate limit for the login endpoint. */
  private loginRateExceeded(source: string): boolean {
    const now = Date.now();
    const e = this.loginHits.get(source);
    if (!e || e.resetAt < now) {
      this.loginHits.set(source, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return false;
    }
    e.count++;
    return e.count > LOGIN_MAX_PER_SOURCE;
  }

  /** Router for the owner-password submit (mounted alongside mcpAuthRouter). */
  loginRouter(): Router {
    const r = Router();
    r.post("/oauth/login", urlencoded({ extended: false, limit: "16kb" }), (req: Request, res: Response) => {
      this.pruneExpired();

      // Per-source rate limit (keyed by the real client IP behind the tunnel).
      const source =
        (req.headers["cf-connecting-ip"] as string | undefined) ??
        (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.ip ??
        "unknown";
      if (this.loginRateExceeded(source)) {
        audit({ event: "auth_fail", success: false, detail: "oauth login: rate limited" });
        this.sendSecureHtml(res, 429, this.errorPage("Too many attempts. Please wait and restart from ChatGPT."));
        return;
      }

      const body = (req.body ?? {}) as { ticket?: unknown; password?: unknown };
      const ticket = typeof body.ticket === "string" ? body.ticket : "";
      const password = typeof body.password === "string" ? body.password : "";

      const ctx = this.pending.get(ticket);
      if (!ctx || ctx.expiresAt < Date.now()) {
        this.pending.delete(ticket);
        const completed = this.completed.get(ticket);
        if (completed && completed.expiresAt >= Date.now() && ctEqual(password, this.config.ownerToken)) {
          this.redirectWithCode(res, completed);
          return;
        }
        this.sendSecureHtml(
          res,
          400,
          this.errorPage("This authorization request expired or is invalid. Please restart it from ChatGPT."),
        );
        return;
      }

      if (!ctEqual(password, this.config.ownerToken)) {
        ctx.attempts += 1;
        audit({ event: "auth_fail", success: false, detail: `oauth login: wrong password (${ctx.attempts})` });
        // Burn the ticket after too many guesses, so the attacker must go back
        // through the SDK-rate-limited /authorize for a fresh one.
        if (ctx.attempts >= MAX_TICKET_ATTEMPTS) {
          this.pending.delete(ticket);
          this.sendSecureHtml(res, 429, this.errorPage("Too many attempts. Please restart authorization from ChatGPT."));
          return;
        }
        const client =
          this.clients.get(ctx.clientId) ?? ({ client_id: ctx.clientId } as OAuthClientInformationFull);
        this.sendSecureHtml(res, 401, this.loginPage(ticket, client, true));
        return;
      }

      // Success → mint a single-use auth code, redirect back to ChatGPT.
      this.pending.delete(ticket);
      this.completed.set(ticket, { ...ctx, expiresAt: Date.now() + CODE_TTL_MS });
      this.redirectWithCode(res, ctx);
    });
    return r;
  }

  private redirectWithCode(res: Response, ctx: AuthContext): void {
    const code = newToken();
    this.codes.set(code, { ...ctx, expiresAt: Date.now() + CODE_TTL_MS });

    const redirect = new URL(ctx.redirectUri);
    redirect.searchParams.set("code", code);
    if (ctx.state !== undefined) redirect.searchParams.set("state", ctx.state);
    audit({
      event: "auth_ok",
      success: true,
      detail: `oauth login ok; redirect=${redirect.origin}${redirect.pathname}; params=${[...redirect.searchParams.keys()].join(",")}`,
    });
    this.sendRedirectHtml(res, redirect.toString());
  }

  // --------------------------------------------------------------- PKCE + code
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const ctx = this.codes.get(authorizationCode);
    if (!ctx || ctx.clientId !== client.client_id || ctx.expiresAt < Date.now()) {
      throw new Error("invalid_grant");
    }
    return ctx.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const ctx = this.codes.get(authorizationCode);
    if (!ctx || ctx.clientId !== client.client_id || ctx.expiresAt < Date.now()) {
      this.codes.delete(authorizationCode);
      audit({ event: "auth_fail", success: false, detail: "oauth token: invalid authorization code" });
      throw new Error("invalid_grant");
    }
    if (redirectUri !== undefined && redirectUri !== ctx.redirectUri) {
      audit({ event: "auth_fail", success: false, detail: "oauth token: redirect_uri mismatch" });
      throw new Error("invalid_grant");
    }
    this.codes.delete(authorizationCode); // single use
    audit({ event: "auth_ok", success: true, detail: "oauth token exchange ok" });
    return this.issueTokens(ctx.clientId, ctx.scopes, ctx.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const info = this.refreshTokens.get(refreshToken);
    if (!info || info.clientId !== client.client_id) {
      audit({ event: "auth_fail", success: false, detail: "oauth refresh: invalid refresh token" });
      throw new Error("invalid_grant");
    }
    const granted = scopes && scopes.length ? scopes.filter((s) => info.scopes.includes(s)) : info.scopes;

    const access = newToken();
    this.accessTokens.set(access, {
      clientId: info.clientId,
      scopes: granted,
      resource: info.resource,
      expiresAt: Date.now() + ACCESS_TTL_SEC * 1000,
    });
    this.persist();
    audit({ event: "auth_ok", success: true, detail: "oauth refresh ok" });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      scope: granted.join(" "),
      refresh_token: refreshToken,
    };
  }

  private issueTokens(clientId: string, scopes: string[], resource: string): OAuthTokens {
    const access = newToken();
    const refresh = newToken();
    this.accessTokens.set(access, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + ACCESS_TTL_SEC * 1000,
    });
    this.refreshTokens.set(refresh, { clientId, scopes, resource });
    this.persist();
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      scope: scopes.join(" "),
      refresh_token: refresh,
    };
  }

  // ----------------------------------------------------------------- verify
  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    // The static owner token is always accepted (curl / Inspector / local).
    if (this.config.ownerToken && ctEqual(accessToken, this.config.ownerToken)) {
      return {
        token: accessToken,
        clientId: "owner",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC,
        resource: this.resourceUrl,
      };
    }
    const info = this.accessTokens.get(accessToken);
    if (!info || info.expiresAt < Date.now()) {
      this.accessTokens.delete(accessToken);
      if (info) this.persist();
      audit({
        event: "auth_fail",
        success: false,
        detail: info ? "oauth access: expired token" : "oauth access: unknown token",
      });
      throw new Error("invalid_token");
    }
    audit({ event: "auth_ok", success: true, detail: "oauth access token ok" });
    return {
      token: accessToken,
      clientId: info.clientId,
      scopes: info.scopes,
      expiresAt: Math.floor(info.expiresAt / 1000),
      resource: new URL(info.resource),
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const accessDeleted = this.accessTokens.delete(request.token);
    const refreshDeleted = this.refreshTokens.delete(request.token);
    if (accessDeleted || refreshDeleted) this.persist();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.completed) if (v.expiresAt < now) this.completed.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    let prunedAccess = false;
    for (const [k, v] of this.accessTokens) {
      if (v.expiresAt < now) {
        this.accessTokens.delete(k);
        prunedAccess = true;
      }
    }
    if (prunedAccess) this.persist();
    for (const [k, v] of this.loginHits) if (v.resetAt < now) this.loginHits.delete(k);
  }
}
