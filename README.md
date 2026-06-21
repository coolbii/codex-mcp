# devspace

A small, **auditable** self-hosted [MCP](https://modelcontextprotocol.io) server
that gives an AI client (Claude Desktop, the MCP Inspector, any local MCP host,
and — via a tunnel — ChatGPT) **narrow, sandboxed** access to selected local
folders: read, list, search, write, edit, and an *optional* restricted shell.

It is a from-scratch rebuild inspired by [Waishnav/devspace](https://github.com/Waishnav/devspace),
written so you can read every line. The design rule throughout:

> The model never gets "your computer." It gets specific tools. Each tool
> checks authorization, workspace identity, and path containment **before**
> touching anything. **File tools can be made fairly safe with path
> containment; shell cannot** — so shell is disabled by default and treated as
> handing over your local user account.

## Security posture at a glance

- **Path containment** — every path is resolved with `realpath` and confined to
  an opened workspace that sits inside a pre-approved allowed root. Symlink
  escapes, `../` traversal, and write-through-symlink are rejected. Reads use
  `O_NOFOLLOW`; new files use `O_CREAT|O_EXCL|O_NOFOLLOW`; overwrites are atomic
  temp-write + rename. (See [`src/path-guard.ts`](src/path-guard.ts).)
- **Narrow roots** — the server *refuses* to start if an allowed root is your
  home dir, `/`, a dir containing your home, or a secrets dir (`~/.ssh`, …).
- **Auth** — the HTTP transport requires an owner bearer token (constant-time
  compare), wrapped in spec-shaped OAuth discovery so unauthenticated requests
  get a proper `401` + `WWW-Authenticate` challenge. For **ChatGPT web**, an
  embedded OAuth 2.1 server (`AUTH_MODE=oauth`) adds DCR + PKCE + owner-password
  login.
- **DNS-rebinding / cross-origin** — an edge `Host`/`Origin` allowlist runs
  *plus* the SDK transport's own protection (belt and suspenders).
- **Shell off by default** — when enabled, it is an allowlist of read-only
  commands, spawned with `shell:false` (no metacharacter interpretation) and a
  scrubbed environment (no secrets reach the child). `git` is run with hardening
  flags that neutralise on-disk `.git/config` code-execution keys, and writes
  into `.git/**` are denied at the boundary.
- **Bounded search** — literal by default; regex runs on the linear-time `re2`
  engine (or is refused), so a crafted pattern can't freeze the event loop.
- **Secret-free logs** — structured JSON audit log to **stderr** with token /
  content / env redaction.

See **[docs/security.md](docs/security.md)** for the threat model and the
enforce-in-code checklist.

## Requirements

- Node `>=20.12 <27` (tested on Node 24). No system binaries (no `ripgrep`) —
  traversal/search are in-process. Regex search uses the optional `re2` engine
  (installed by default via `optionalDependencies`); literal search needs nothing.

## Install

```bash
cd ~/bindev/devspace
npm install
npm run build            # compiles to dist/
cp .env.example .env     # then edit ALLOWED_ROOTS (and OWNER_TOKEN for HTTP)
```

Run the tests and smoke checks any time:

```bash
npm test                 # unit tests (path-guard, config, edit, search, shell, OAuth…)
node scripts/smoke-stdio.mjs   # end-to-end over stdio with the real MCP client
```

## Run

There are two transports. Both serve the **same** tools.

### stdio (local clients that spawn the server)

```bash
ALLOWED_ROOTS=/Users/you/code/sandbox npm run start:stdio
```

### Streamable HTTP (remote clients / ChatGPT via a tunnel)

```bash
# uses .env; prints the owner token if it had to generate one
npm run start:http
# → http://127.0.0.1:7676/mcp
```

During development, `npm run dev:http` / `npm run dev:stdio` run from TypeScript
with reload.

## Connect a client

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "devspace": {
      "command": "node",
      "args": ["/Users/you/bindev/devspace/dist/bin/stdio.js"],
      "env": { "ALLOWED_ROOTS": "/Users/you/code/sandbox" }
    }
  }
}
```

### MCP Inspector (either transport)

```bash
npx @modelcontextprotocol/inspector
# stdio: command=node  args=dist/bin/stdio.js  env ALLOWED_ROOTS=…
# http:  url=http://127.0.0.1:7676/mcp  + Authorization: Bearer <OWNER_TOKEN>
```

### curl (HTTP, to sanity-check)

```bash
TOKEN=… # your OWNER_TOKEN
curl -s -X POST http://127.0.0.1:7676/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

### ChatGPT web (Developer Mode, via an HTTPS tunnel)

Supported via an **embedded OAuth 2.1 server** (`AUTH_MODE=oauth`). ChatGPT's
connector only speaks OAuth (it can't send a pasted token), so devspace runs the
OAuth dance itself: ChatGPT auto-registers (DCR) + PKCE, and you authorize once
by entering your `OWNER_TOKEN` as the password.

```bash
AUTH_MODE=oauth PUBLIC_BASE_URL=https://devspace.example.com \
ALLOWED_HOSTS=devspace.example.com OWNER_TOKEN=<32+chars> \
ALLOWED_ROOTS=/Users/you/code/sandbox npm run start:http
```

Expose `127.0.0.1:7676` with a Cloudflare named tunnel, then add
`https://devspace.example.com/mcp` as a custom connector with **Authentication:
OAuth**. The owner token still works as a bearer in this mode, so local clients
keep working too.

**Start here — end-to-end usage guide:
[English](docs/usage-guide.md) · [繁體中文](docs/usage-guide.zh-TW.md).**
Deeper reference (tunnel internals, de-risk rungs, troubleshooting) →
[docs/chatgpt-setup.md](docs/chatgpt-setup.md). Verify the whole OAuth flow
locally first with `node scripts/smoke-oauth.mjs`.

## Tools

| Tool | Read-only | Description |
|---|---|---|
| `list_roots` | ✓ | List directories the server may open. |
| `open_workspace` | ✓ | Open a dir (root or beneath one) → returns a `workspaceId`. |
| `list_workspaces` | ✓ | Workspaces opened this session. |
| `read_file` | ✓ | Read a UTF-8 file (optional line range; binary-safe). |
| `list_directory` | ✓ | List a directory (non-recursive). |
| `find_files` | ✓ | Find files by glob; symlink-safe; respects `.gitignore`. |
| `search_files` | ✓ | Content search (literal or regex); `file:line` matches. |
| `show_diff` | ✓ | Preview the diff a write would make — no disk change. |
| `write_file` | ✗ | Create/overwrite a file (atomic); returns a diff. |
| `edit_file` | ✗ | Exact `oldText`→`newText` replacement(s); returns a diff. |
| `create_site` | ✗ | Create a versioned static website preview under `devspace-sites`. |
| `update_site` | ✗ | Update a generated site and commit a new version. |
| `list_sites` / `get_site_versions` | ✓ | Inspect generated sites and git history. |
| `install_packages` | ✗ | **Only if `ENABLE_PACKAGE_INSTALL=1`.** Install model-inferred registry packages with npm/pnpm/yarn/bun; install scripts disabled by default. |
| `create_app` | ✗ | **Only if `ENABLE_APP_SCAFFOLD=1`.** Scaffold a React or Next.js app inside an existing Nx monorepo using the workspace-local Nx binary. |
| `run_command` | ✗ | **Only if `ENABLE_SHELL=1`.** Allowlisted, no-shell command. |

Every call (except `list_roots`/`open_workspace`/`list_workspaces`) takes the
`workspaceId` from `open_workspace`.

Generated site previews are documented in
[docs/generated-sites.md](docs/generated-sites.md). The default visual direction
for generated pages lives in
[docs/site-design-direction.md](docs/site-design-direction.md).

## Roadmap

1. ✅ **ChatGPT web support** — embedded OAuth 2.1 AS (`AUTH_MODE=oauth`):
   Dynamic Client Registration + PKCE + owner-password login, owner token still
   accepted as a bearer. See [docs/chatgpt-setup.md](docs/chatgpt-setup.md).
2. **Container/sandbox shell mode** (`--network=none`, read-only FS except the
   bind-mounted root, dropped caps) — the only *strong* boundary for command
   execution and the closure for the documented TOCTOU residual.

## Layout

```
src/
  config.ts            fail-closed configuration
  path-guard.ts        realpath read/write containment   ← the hard boundary
  workspaces.ts        open_workspace registry
  audit-log.ts         secret-free stderr JSON logging
  fs-tools.ts          read_file, list_directory
  search-tools.ts      find_files, search_files
  edit-tools.ts        write_file, edit_file, show_diff
  site-tools.ts        generated static site previews + per-site git history
  shell-tools.ts       run_command (disabled by default)
  host-origin-guard.ts edge DNS-rebinding / origin guard
  auth.ts              auth mode switch (owner-token / oauth)
  oauth-provider.ts    embedded OAuth 2.1 AS (DCR + PKCE) for ChatGPT
  http.ts              Streamable HTTP transport
  stdio.ts             stdio transport
  mcp-server.ts        tool registration (zod schemas, hints)
  bin/{http,stdio}.ts  entrypoints
tests/                 vitest suite
docs/security.md       threat model + checklist
```
