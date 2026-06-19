# Connecting devspace to ChatGPT web

This is the end-to-end runbook to let **ChatGPT web** read/edit code in a
sandboxed local folder through devspace — e.g. to offload coding work and avoid
Codex token limits.

ChatGPT's custom-connector only speaks **OAuth** (it can't send a pasted token),
so devspace runs an **embedded OAuth 2.1 server** (`AUTH_MODE=oauth`). ChatGPT
auto-registers (DCR) and runs the PKCE flow; you authorize once by entering your
`OWNER_TOKEN` as the password.

```
ChatGPT web ──HTTPS──▶ Cloudflare tunnel ──▶ 127.0.0.1:7676 (devspace)
   │  OAuth: discovery → DCR → /authorize (you log in) → /token → Bearer
   ▼
 tools: read_file / list_directory / search_files / write_file / edit_file …
```

## Prerequisites

- A ChatGPT plan with **Developer Mode** (Plus/Pro/Business/Enterprise/Edu — not
  Free). Business/Enterprise/Edu may need a workspace admin to enable custom MCP.
- A **Cloudflare-managed domain** (for a stable named tunnel) and `cloudflared`
  installed (`brew install cloudflared`).
- devspace built (`npm run build`) and a **narrow** `ALLOWED_ROOTS`.
- A stable `OWNER_TOKEN` (this is BOTH your login password AND a bearer token —
  keep it secret, 32+ chars):
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

## Step 1 — configure devspace for OAuth

Create `.env` in `~/bindev/devspace`:

```bash
ALLOWED_ROOTS=/Users/you/code/sandbox     # NARROW. never ~, /, or a secrets dir
HOST=127.0.0.1
PORT=7676
AUTH_MODE=oauth
PUBLIC_BASE_URL=https://devspace.example.com   # your tunnel hostname, origin only
ALLOWED_HOSTS=devspace.example.com             # the tunnel Host header
OWNER_TOKEN=<your-32+char-token>
OAUTH_STORE_PATH=./data/devspace-oauth.json
# ENABLE_SHELL stays unset (OFF) — recommended for a ChatGPT-facing server
```

> `PUBLIC_BASE_URL` is the **origin only** (no `/mcp`). devspace uses it as the
> OAuth issuer/resource, and auto-adds its host to the allowlist. Setting
> `ALLOWED_HOSTS` explicitly (to the tunnel host) is recommended — if you set it,
> it replaces the auto list, so include the tunnel host.

## Step 2 — create a Cloudflare named tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create devspace
cloudflared tunnel route dns devspace devspace.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: devspace
ingress:
  - hostname: devspace.example.com
    service: http://127.0.0.1:7676
    originRequest:
      disableChunkedEncoding: true   # avoids edge buffering of MCP responses
  - service: http_status:404
```

## Step 3 — run both

```bash
# terminal 1
cd ~/bindev/devspace && npm run start:http
# terminal 2
cloudflared tunnel run devspace
```

## Step 4 — de-risk locally BEFORE adding ChatGPT

The OAuth handshake is the fiddliest part. Confirm each rung is green first:

```bash
# A. the bundled end-to-end OAuth smoke (DCR → login → PKCE → authed /mcp)
node scripts/smoke-oauth.mjs        # expect: ✅ OAuth end-to-end smoke passed

# B. discovery + 401 challenge over the real tunnel
curl -s https://devspace.example.com/.well-known/oauth-authorization-server | jq .
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://devspace.example.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'   # expect 401

# C. (optional) full OAuth flow in the MCP Inspector against the tunnel URL
npx @modelcontextprotocol/inspector
#    url = https://devspace.example.com/mcp ; it runs discovery+DCR+PKCE and
#    opens the login page — enter your OWNER_TOKEN.
```

## Step 5 — add the connector in ChatGPT

1. ChatGPT → **Settings → Apps & Connectors** (older UI: "Connectors") →
   **Advanced → Developer Mode: ON**.
2. **Apps & Connectors → Create** (add a custom connector).
3. **Name:** `DevSpace`. **URL:** `https://devspace.example.com/mcp`
   (the full `/mcp` path — ChatGPT does **not** append it).
4. **Authentication: OAuth.** (ChatGPT discovers everything via the well-knowns.)
5. Accept the unverified-connector warning → **Connect**.
6. ChatGPT opens devspace's login page → **enter your `OWNER_TOKEN` as the
   password** → you're redirected back and the connector shows **Connected**.
7. In a chat, the tools appear. Read tools run directly; **write tools
   (`write_file`/`edit_file`) prompt a confirmation** — expand it to inspect the
   JSON args before approving.

## Using it

Ask ChatGPT things like *"open the workspace at `/Users/you/code/sandbox`, find
where X is defined, and refactor it"*. The model will `open_workspace` →
`search_files`/`read_file` → `show_diff` → `edit_file`. Approve writes when
prompted.

## Security notes

- **Narrow root + shell off.** A ChatGPT-facing server exposes those files to
  OpenAI's servers and to prompt-injection in any file the model reads. Keep
  `ALLOWED_ROOTS` to a dedicated sandbox and leave `ENABLE_SHELL` off.
- **The tunnel URL is not a secret**, but OAuth + your `OWNER_TOKEN` are the
  gate. Consider adding Cloudflare Access in front for a second layer.
- **`OWNER_TOKEN` is high-value** — it's your login password AND a direct bearer
  token. Rotate it by changing `.env` and restarting (ChatGPT re-authorizes).
- **`data/devspace-oauth.json`** holds the registered client + refresh tokens
  (mode 0600, git-ignored). Don't delete it casually — losing it forces ChatGPT
  to reconnect. Back it up like a secret.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| ChatGPT "couldn't connect" immediately | discovery not reachable — check `curl …/.well-known/oauth-authorization-server` over the tunnel; confirm `PUBLIC_BASE_URL` matches the tunnel host exactly |
| 403 `host_not_allowed` | tunnel host not in `ALLOWED_HOSTS` — add `devspace.example.com` |
| Login page never appears | `/authorize` blocked — confirm the tunnel forwards to `127.0.0.1:7676` and devspace logs `auth: OAuth 2.1 embedded AS` at startup |
| "Connected" but no tools | re-open the connector; check the server log for a `tools registered` line |
| Works, then breaks after a server restart | you lost `data/devspace-oauth.json` or `OWNER_TOKEN` changed — reconnect in ChatGPT |
| Tool calls hang | tunnel buffering — ensure `disableChunkedEncoding: true` and a **named** tunnel (not a quick tunnel) |
