# Usage guide — driving devspace from ChatGPT

> 繁體中文版 → [usage-guide.zh-TW.md](usage-guide.zh-TW.md)

This is the end-to-end walkthrough: from zero to "ChatGPT is editing code in a
folder on my Mac." For the deeper reference (tunnel internals, troubleshooting
table), see [chatgpt-setup.md](chatgpt-setup.md).

## Mental model (one sentence)

> devspace runs **on your Mac** → a Cloudflare tunnel exposes it safely on the
> internet → **ChatGPT** connects and can read/write the code in **one folder you
> chose**.

```
You type in ChatGPT  ──▶  ChatGPT servers  ──HTTPS──▶  your Cloudflare domain
                                                           │ tunnel
                                                           ▼
                                          your Mac: devspace (127.0.0.1:7676)
                                                           │ can only touch
                                                           ▼
                                          ~/code/sandbox   ← the folder you chose
```

## Prerequisites

- A ChatGPT plan with **Developer Mode** (Plus/Pro/Business/Enterprise/Edu — not
  Free).
- A **Cloudflare-managed domain** + `cloudflared` (`brew install cloudflared`).
- devspace built: `cd ~/bindev/devspace && npm install && npm run build`.

---

## Part A — One-time setup (~15 minutes, done once)

### 1. Pick a sandbox folder + a token

```bash
mkdir -p ~/code/sandbox            # put the code you want ChatGPT to work on here
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# ↑ copy this — it's your OWNER_TOKEN (your login password)
```

### 2. Write `~/bindev/devspace/.env`

```bash
ALLOWED_ROOTS=/Users/you/code/sandbox
AUTH_MODE=oauth
PUBLIC_BASE_URL=https://devspace.example.com
ALLOWED_HOSTS=devspace.example.com
OWNER_TOKEN=<the token you just generated>
# ENABLE_SHELL stays unset (off) — recommended
```

### 3. Create a Cloudflare named tunnel (stable URL)

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
      disableChunkedEncoding: true
  - service: http_status:404
```

### 4. Add the connector in ChatGPT (authorize once)

1. ChatGPT → **Settings → Apps & Connectors** → Advanced → **Developer Mode: ON**
2. **Create** a custom connector → URL: `https://devspace.example.com/mcp`,
   Authentication: **OAuth**
3. devspace's login page opens → **enter your `OWNER_TOKEN`** → Connected ✅

> This login is **one-time**. devspace persists the OAuth refresh token, so even
> after you restart it ChatGPT stays connected — you don't log in again unless you
> change `OWNER_TOKEN`.

---

## Part B — Daily use (two terminals, one command each)

```bash
# terminal 1 — start devspace
cd ~/bindev/devspace && npm run dev:http

# terminal 2 — start the tunnel
cloudflared tunnel run devspace
```

`dev:http` loads `.env` automatically and hot-reloads TypeScript changes. For a
compiled production-style run, use `npm run build && npm run start:http`.

Leave both running. (To run them automatically at login, make them launchd
services — ask and the repo can include a template.)

---

## Part C — Using it inside ChatGPT

Just ask in plain language, e.g.:

> "Open the workspace at `/Users/you/code/sandbox`, find where `parseConfig` is
> defined, change it to support YAML, and show me the diff."

Behind the scenes ChatGPT calls the tools in order:

```
open_workspace → search_files / read_file → show_diff → edit_file
```

- **Read tools** (find / read / search) run directly — no interruption.
- **Write tools** (`write_file` / `edit_file`) pop a **confirmation** — expand it
  to inspect the exact JSON args, then approve to actually change the file on disk.

When it's done, the changes are right there in `~/code/sandbox` on your Mac — run
tests, `git commit`, etc. That's how you offload the heavy coding token spend to
ChatGPT instead of Codex.

## What each tool does

| Tool | Read-only | What it does |
|---|---|---|
| `open_workspace` | ✓ | Open a folder → returns a `workspaceId` used by every later call |
| `list_directory` / `find_files` / `search_files` | ✓ | Explore the tree / grep content |
| `read_file` | ✓ | Read a file (optional line range) |
| `show_diff` | ✓ | Preview a change without writing |
| `write_file` / `edit_file` | ✗ | Create/overwrite, or exact-string edit — prompts |
| `create_site` / `update_site` | ✗ | Create or update a versioned static website preview |
| `list_sites` / `get_site_versions` | ✓ | Inspect generated site previews and their git history |
| `install_packages` | ✗ | Optional. Enabled only with `ENABLE_PACKAGE_INSTALL=1`; ChatGPT infers registry packages, you approve the list, install scripts stay disabled. |
| `create_app` | ✗ | Optional. Enabled only with `ENABLE_APP_SCAFFOLD=1`; scaffolds React/Next apps in an existing Nx monorepo or creates an isolated Nx + Next workspace. |

Generated site previews are written under
`<first ALLOWED_ROOTS>/devspace-sites/<siteId>/` and served at
`<PUBLIC_BASE_URL>/sites/<siteId>/`. See
[generated-sites.md](generated-sites.md).

## Security notes

- **Keep `ALLOWED_ROOTS` to that one sandbox folder** — not your home dir or a
  whole project root. ChatGPT (and any prompt-injection in files it reads) can
  only reach that scope. devspace refuses dangerous roots outright.
- **Shell stays off** by default — keep it that way for a ChatGPT-facing server.
- **Package install is opt-in** — enable `ENABLE_PACKAGE_INSTALL=1` only when
  React/Next/Nx generation needs dependencies. ChatGPT should infer the minimal
  package list from the task and `package.json`; you review that list in the
  tool approval UI. It is not a generic shell and install scripts are disabled
  by default.
- **Nx app scaffolding is opt-in** — enable `ENABLE_APP_SCAFFOLD=1` only for
  trusted workspaces. `create_app` has two modes:
  - `mode=existing` runs `node_modules/.bin/nx` from a healthy existing Nx
    monorepo and will not download Nx through `npx` or `bunx`.
  - `mode=isolated` writes a clean Nx + Next workspace template under the opened
    workspace, defaulting to `devspace-apps/<appName>`. Use this when the parent
    folder contains many unrelated projects or a broken Nx project graph.
- Treat `OWNER_TOKEN` and `data/devspace-oauth.json` as secrets (the latter is
  git-ignored).

## Verify before you trust it

```bash
node scripts/smoke-oauth.mjs   # runs the full OAuth flow locally — expect ✅
```

Troubleshooting table: [chatgpt-setup.md](chatgpt-setup.md#troubleshooting).
