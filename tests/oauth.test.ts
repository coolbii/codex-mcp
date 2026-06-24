import { it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { PathGuard } from "../src/path-guard.js";
import { makeApp } from "../src/http.js";

const OWNER = "owner_tok_" + "a".repeat(40);
const b64url = (b: Buffer): string => b.toString("base64url");
const REDIRECT = "http://localhost:9/cb";
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}

let server: Server;
let origin: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "devspace-oauthtest-"));
  const port = await freePort();
  const config = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: root,
      OWNER_TOKEN: OWNER,
      AUTH_MODE: "oauth",
      HOST: "127.0.0.1",
      PORT: String(port),
      OAUTH_STORE_PATH: join(root, "oauth.json"),
    },
    warn: () => {},
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  await new Promise<void>((r) => {
    server = app.listen(port, "127.0.0.1", () => r());
  });
  origin = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

async function asMetadata(): Promise<Record<string, any>> {
  return (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Promise<Record<string, any>>;
}

async function register(name: string): Promise<Record<string, any>> {
  const as = await asMetadata();
  const r = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  return r.json() as Promise<Record<string, any>>;
}

async function mcpRequest(body: Record<string, any>, sessionId?: string): Promise<Response> {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${OWNER}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSseJson(text: string): Record<string, any> {
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (!data) throw new Error(`No SSE data line: ${text}`);
  return JSON.parse(data) as Record<string, any>;
}

async function initializeMcpSession(): Promise<string> {
  const r = await mcpRequest(JSON.parse(INIT));
  expect(r.status).toBe(200);
  const sid = r.headers.get("mcp-session-id");
  if (!sid) throw new Error("No mcp-session-id");
  return sid;
}

async function callTool(
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, any>,
): Promise<Record<string, any>> {
  const r = await mcpRequest(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    sessionId,
  );
  expect(r.status).toBe(200);
  return parseSseJson(await r.text());
}

/** Drive /authorize → login → returns the auth code. */
async function getCode(clientId: string, challenge: string): Promise<string> {
  const as = await asMetadata();
  const au = new URL(as.authorization_endpoint);
  au.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s1",
    scope: "mcp",
  }).toString();
  const page = await (await fetch(au)).text();
  const ticket = page.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) throw new Error("no ticket");
  const login = await fetch(`${origin}/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket, password: OWNER }).toString(),
    redirect: "manual",
  });
  if (login.status !== 200) throw new Error(`login status ${login.status}`);
  const loginHtml = await login.text();
  const redirectUrl = loginHtml.match(/id="continue" href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!redirectUrl) throw new Error("no redirect url");
  const code = new URL(redirectUrl).searchParams.get("code");
  if (!code) throw new Error("no code");
  return code;
}

it("serves AS metadata advertising S256 + DCR", async () => {
  const m = await asMetadata();
  expect(m.code_challenge_methods_supported).toContain("S256");
  expect(m.registration_endpoint).toBeTruthy();
});

it("unauthenticated /mcp returns 401 with resource_metadata", async () => {
  const r = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: INIT,
  });
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate") ?? "").toMatch(/resource_metadata=/);
});

it("owner token still works as a bearer in oauth mode", async () => {
  const r = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${OWNER}`,
    },
    body: INIT,
  });
  expect(r.status).toBe(200);
});

it("keeps workspace handles usable across HTTP transport sessions", async () => {
  const sessionA = await initializeMcpSession();
  const opened = await callTool(sessionA, 2, "open_workspace", { path: root });
  const workspaceId = opened.result?.structuredContent?.workspaceId;
  expect(workspaceId).toBeTruthy();

  const sessionB = await initializeMcpSession();
  const listed = await callTool(sessionB, 3, "list_directory", { workspaceId });
  expect(listed.result?.isError).not.toBe(true);
  expect(listed.result?.structuredContent?.path).toBe(".");
});

it("completes the full DCR → PKCE → token → authed /mcp flow", async () => {
  const client = await register("flow");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const code = await getCode(client.client_id, challenge);

  const as = await asMetadata();
  const tok = (await (
    await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    })
  ).json()) as Record<string, any>;
  expect(tok.access_token).toBeTruthy();
  expect(tok.refresh_token).toBeTruthy();

  const mcp = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tok.access_token}`,
    },
    body: INIT,
  });
  expect(mcp.status).toBe(200);
  expect(await mcp.text()).toContain("devspace");
});

it("rejects a token exchange with the wrong PKCE verifier", async () => {
  const client = await register("badpkce");
  const challenge = b64url(createHash("sha256").update("the-real-verifier").digest());
  const code = await getCode(client.client_id, challenge);
  const as = await asMetadata();
  const tok = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: "a-different-wrong-verifier",
    }).toString(),
  });
  expect(tok.ok).toBe(false);
});

it("rejects an auth code replay (single use)", async () => {
  const client = await register("replay");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const code = await getCode(client.client_id, challenge);
  const as = await asMetadata();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
  }).toString();
  const first = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  expect(first.ok).toBe(true);
  const second = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  expect(second.ok).toBe(false);
});

it("rotates refresh tokens but tolerates ChatGPT's concurrent refresh (grace window)", async () => {
  const client = await register("rotate-refresh");
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const code = await getCode(client.client_id, challenge);
  const as = await asMetadata();
  const refreshOnce = (rt: string) =>
    fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: client.client_id }).toString(),
    });
  const tok = (await (
    await fetch(as.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }).toString(),
    })
  ).json()) as Record<string, any>;
  const refreshed = (await (await refreshOnce(tok.refresh_token)).json()) as Record<string, any>;
  expect(refreshed.access_token).toBeTruthy();
  expect(refreshed.refresh_token).toBeTruthy();
  expect(refreshed.refresh_token).not.toBe(tok.refresh_token); // rotated
  expect((await refreshOnce(refreshed.refresh_token)).ok).toBe(true); // the NEW one works
  // The OLD token still works within the grace window (this is what stops
  // ChatGPT's parallel refresh from invalidating the whole grant) and returns a
  // valid access token rather than erroring.
  const dup = await refreshOnce(tok.refresh_token);
  expect(dup.ok).toBe(true);
  expect(((await dup.json()) as Record<string, any>).access_token).toBeTruthy();
});

it("burns the login ticket after repeated wrong passwords", async () => {
  const client = await register("lockout");
  const challenge = b64url(createHash("sha256").update("v").digest());
  const as = await asMetadata();
  const au = new URL(as.authorization_endpoint);
  au.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "mcp" }).toString();
  const ticket = (await (await fetch(au)).text()).match(/name="ticket" value="([^"]+)"/)?.[1] as string;
  const tryLogin = (pw: string) =>
    fetch(`${origin}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, password: pw }).toString(),
      redirect: "manual",
    });
  for (let i = 0; i < 4; i++) expect((await tryLogin("nope")).status).toBe(401);
  expect((await tryLogin("nope")).status).toBe(429); // 5th burns the ticket
  // even the CORRECT password now fails — the ticket is dead
  const after = await tryLogin(OWNER);
  expect(after.status).not.toBe(302);
});

it("puts the site/preview routes behind the host guard (not public)", async () => {
  const u = new URL(origin);
  const rawGet = (path: string, host?: string): Promise<number | undefined> =>
    new Promise((resolveStatus) => {
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path, method: "GET", ...(host ? { headers: { host } } : {}) },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode);
        },
      );
      req.end();
    });
  // Forged Host (DNS-rebinding) is rejected by the guard...
  expect(await rawGet("/sites/none", "evil.attacker.example")).toBe(403);
  // ...while the correct host passes the guard and reaches the handler (404).
  expect(await rawGet("/sites/none")).toBe(404);
});

it("rejects login with the wrong owner password", async () => {
  const client = await register("badpw");
  const challenge = b64url(createHash("sha256").update("v").digest());
  const as = await asMetadata();
  const au = new URL(as.authorization_endpoint);
  au.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
  }).toString();
  const ticket = (await (await fetch(au)).text()).match(/name="ticket" value="([^"]+)"/)?.[1];
  const login = await fetch(`${origin}/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket: ticket!, password: "wrong-password" }).toString(),
    redirect: "manual",
  });
  expect(login.status).toBe(401);
});
