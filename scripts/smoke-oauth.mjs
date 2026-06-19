/**
 * End-to-end OAuth handshake smoke (mirrors what ChatGPT does).
 * Spawns the HTTP server in AUTH_MODE=oauth and runs the full dance:
 *   discovery → DCR → /authorize (login) → /token (PKCE) → authed /mcp
 * plus negatives (no token → 401, wrong password → re-login) and the
 * owner-token bearer fallback + refresh-token grant.
 * Run after `npm run build`:  node scripts/smoke-oauth.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const PORT = 7799;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OWNER = "owner_tok_0123456789abcdef0123456789ABCD";
const REDIRECT = "http://localhost:9999/callback";

const root = mkdtempSync(join(tmpdir(), "devspace-oauth-"));
const storePath = join(root, "oauth.json");

const srv = spawn("node", ["dist/bin/http.js"], {
  env: {
    ...process.env,
    ALLOWED_ROOTS: root,
    OWNER_TOKEN: OWNER,
    AUTH_MODE: "oauth",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    OAUTH_STORE_PATH: storePath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
srv.stdout.on("data", (d) => (serverLog += d));
srv.stderr.on("data", (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${ORIGIN}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server did not become healthy");
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});

let failed = false;
try {
  await waitHealthy();

  // 1) discovery
  const asMeta = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
  console.log("AS metadata: authorize=%s token=%s register=%s", asMeta.authorization_endpoint, asMeta.token_endpoint, asMeta.registration_endpoint);
  assert(asMeta.authorization_endpoint && asMeta.token_endpoint && asMeta.registration_endpoint, "AS metadata incomplete");
  assert(asMeta.code_challenge_methods_supported?.includes("S256"), "S256 not advertised");

  // PRM is discovered the way ChatGPT does it: unauth /mcp → 401 → resource_metadata
  const challenge401 = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: INIT,
  });
  assert(challenge401.status === 401, `unauth /mcp should 401, got ${challenge401.status}`);
  const wwwAuth = challenge401.headers.get("www-authenticate") || "";
  const rmUrl = wwwAuth.match(/resource_metadata="([^"]+)"/)?.[1];
  assert(rmUrl, `no resource_metadata in WWW-Authenticate: ${wwwAuth}`);
  const prm = await (await fetch(rmUrl)).json();
  assert(Array.isArray(prm.authorization_servers) && prm.authorization_servers.length, "PRM missing authorization_servers");
  console.log("401 challenge → PRM at %s, authorization_servers: %o", rmUrl, prm.authorization_servers);

  // 2) DCR
  const reg = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "smoke",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const regText = await reg.text();
  assert(reg.ok, `DCR failed: ${reg.status} ${regText}`);
  const client = JSON.parse(regText);
  console.log("DCR client_id:", client.client_id);
  assert(client.client_id, "no client_id from DCR");

  // 3) PKCE + /authorize → login page (extract ticket)
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp",
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const authRes = await fetch(authUrl);
  assert(authRes.status === 200, `/authorize expected 200 login page, got ${authRes.status}`);
  const html = await authRes.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  assert(ticket, "no ticket in login page");
  console.log("login page rendered, ticket captured");

  // 3b) wrong password → 401 re-login
  const badLogin = await fetch(`${ORIGIN}/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket, password: "wrong" }).toString(),
    redirect: "manual",
  });
  assert(badLogin.status === 401, `wrong password should 401, got ${badLogin.status}`);
  console.log("wrong password → 401 ✓");

  // 4) correct password → 302 with code
  const login = await fetch(`${ORIGIN}/oauth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ticket, password: OWNER }).toString(),
    redirect: "manual",
  });
  assert(login.status === 302, `login should 302, got ${login.status}`);
  const loc = new URL(login.headers.get("location"));
  const code = loc.searchParams.get("code");
  assert(code, "no code in redirect");
  assert(loc.searchParams.get("state") === "xyz", "state not echoed");
  console.log("login ok → code issued, state echoed ✓");

  // 5) /token exchange (PKCE)
  const tok = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  const tokText = await tok.text();
  assert(tok.ok, `/token failed: ${tok.status} ${tokText}`);
  const tokens = JSON.parse(tokText);
  assert(tokens.access_token && tokens.refresh_token, "missing tokens");
  console.log("token exchange ok → access+refresh ✓");

  // 5b) replay the code → must fail (single use)
  const replay = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }).toString(),
  });
  assert(!replay.ok, "code replay should fail");
  console.log("code replay → rejected ✓");

  // 6) authed /mcp with the OAuth access token
  const mcp = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` },
    body: INIT,
  });
  assert(mcp.status === 200, `/mcp with OAuth token expected 200, got ${mcp.status}`);
  assert((await mcp.text()).includes("devspace"), "/mcp did not return serverInfo");
  console.log("authed /mcp with OAuth token ✓");

  // 7) no token → 401
  const noAuth = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: INIT });
  assert(noAuth.status === 401, `no token should 401, got ${noAuth.status}`);
  console.log("no token → 401 ✓");

  // 8) owner token still works as bearer in oauth mode
  const ownerMcp = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${OWNER}` }, body: INIT });
  assert(ownerMcp.status === 200, `owner token should work, got ${ownerMcp.status}`);
  console.log("owner token bearer still works ✓");

  // 9) refresh-token grant
  const refreshed = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }).toString(),
  });
  const refreshedText = await refreshed.text();
  assert(refreshed.ok, `refresh failed: ${refreshed.status} ${refreshedText}`);
  assert(JSON.parse(refreshedText).access_token, "no access_token from refresh");
  console.log("refresh-token grant ✓");

  console.log("\n✅ OAuth end-to-end smoke passed");
} catch (e) {
  failed = true;
  console.error("\n❌ OAuth smoke FAILED:", e.message);
} finally {
  srv.kill("SIGKILL");
  await sleep(150);
  if (failed) console.error("--- server log ---\n" + serverLog.slice(0, 2500));
  rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
