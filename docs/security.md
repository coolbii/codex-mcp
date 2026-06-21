# Security model

devspace is **remote-access software**: a connected MCP client can read, search,
write, and (optionally) run commands inside the folders you expose. Treat it that
way. This document is the threat model and the enforce-in-code checklist.

## What we defend against

1. A random internet user who finds your tunnel URL.
2. A malicious web page attempting DNS-rebinding / cross-origin against the
   locally-bound server.
3. Prompt-injected project files telling the model to exfiltrate secrets.
4. Path traversal — `../../.ssh/id_rsa`.
5. Symlink escape from an allowed folder.
6. Shell commands escaping the intended workspace.
7. Logs accidentally storing secrets.
8. Dependency supply-chain compromise.

The core principle: **a capability bridge, not "an AI agent."** Each tool has a
schema and validates authorization → workspace identity → path containment →
limits **before** acting.

## Layered defenses

```
client ──HTTPS/tunnel──▶ Host/Origin guard ──▶ owner-token auth ──▶ session
                                                                     │
                            workspace registry (open_workspace) ◀────┘
                                       │
                                  PathGuard (realpath containment)
                                       │
                          file tools  |  search  |  edit  |  shell(off)
                                       ▼
                              your filesystem (as your OS user)
```

Defenses are intentionally redundant — e.g. even when `fast-glob` yields a path,
the search tool **re-validates** it through the `PathGuard` before opening it;
both the edge `Host`/`Origin` guard **and** the SDK transport's DNS-rebinding
option run.

## Path containment (the hard boundary)

`src/path-guard.ts`:

- **Reads** (`resolveForRead`): resolve relative to the workspace root, then
  `realpath` (resolving every symlink), then assert the result is inside both
  the workspace root and an allowed root. The file tool then opens with
  `O_NOFOLLOW` and `fstat`s the fd — a symlink swapped in at the leaf after the
  check still cannot be followed.
- **Writes** (`resolveForWrite`): the parent dir must already exist and its
  `realpath` must be contained; if the final component is an existing symlink,
  its target must be contained too. New files: `O_CREAT|O_EXCL|O_NOFOLLOW 0o600`.
  Overwrites: write a sibling temp file, fsync, `rename` over the target (rename
  replaces the directory entry, never writes *through* a symlink).

**Residual risk — TOCTOU.** Node has no `openat`/`O_NOFOLLOW` for *intermediate*
path components, so a sufficiently-privileged local attacker who can plant
symlinks inside the workspace at exactly the right moment could in principle race
a check. On a single-user machine this is not a meaningful threat. For multi-user
or untrusted-tenant hosting, run each workspace inside a container/namespace
(see Roadmap in the README) — that is the only strong closure.

## Authentication

`src/auth.ts`. HTTP requires an **owner bearer token** compared in constant time,
wrapped in the SDK's `requireBearerAuth` + `mcpAuthMetadataRouter` so that:

- an unauthenticated `/mcp` request → `401` with
  `WWW-Authenticate: Bearer …, resource_metadata="…/.well-known/oauth-protected-resource/mcp"`;
- `/.well-known/oauth-protected-resource[/mcp]` is served for discovery.

The owner token is the audience boundary. If you later move to JWTs, verify the
`aud`/`resource` claim equals the canonical server URL in `verifyAccessToken`,
and never accept foreign-audience tokens or pass client tokens upstream.

**ChatGPT (`AUTH_MODE=oauth`).** ChatGPT's connector only speaks OAuth (it can't
send a pasted token), so `src/oauth-provider.ts` is an embedded OAuth 2.1
authorization server mounted via the SDK's `mcpAuthRouter`:

- **DCR + PKCE S256.** ChatGPT self-registers (`/register`) and runs Authorization
  Code + PKCE; the SDK verifies `code_verifier` against our stored challenge and
  validates `redirect_uri` against the registered client (open-redirect prevented
  at the SDK layer).
- **Owner-password login.** `/authorize` renders a login page keyed by an opaque
  server-stored ticket; you enter the `OWNER_TOKEN` (constant-time compared). The
  browser only holds the ticket, so it cannot tamper with
  client_id / redirect_uri / code_challenge.
- **Opaque tokens.** Access/refresh tokens + auth codes are 256-bit random; codes
  are single-use + short-TTL; **refresh tokens rotate** on every use (a leaked
  refresh token dies once the real client next refreshes). Only clients + refresh
  tokens persist (`data/devspace-oauth.json`, 0600); access tokens / codes /
  pending logins stay in memory.
- **Brute-force defense.** `/oauth/login` is rate-limited per source and a ticket
  is **burned after 5 wrong passwords**, forcing the attacker back through the
  SDK-rate-limited `/authorize`. Auth pages send `X-Frame-Options: DENY`,
  CSP `frame-ancestors 'none'`, and `Cache-Control: no-store`.
- **Bounded store.** DCR is open by design (ChatGPT self-registers); the client
  set is capped with oldest-eviction so `/register` spam can't grow the file.
- The owner token is **still accepted as a bearer** in oauth mode (local clients).
  In oauth mode it is your login password *and* a bearer — use a high-entropy
  value (`randomBytes(32).base64url`), not a memorable passphrase.

Connecting ChatGPT needs a public HTTPS tunnel — see [chatgpt-setup.md](chatgpt-setup.md).
The OAuth/discovery endpoints are intentionally reachable without the Host/Origin
guard (they carry no file data); only `/mcp` is guarded + token-gated. Do **not**
"solve" anything by setting `ALLOW_INSECURE_LOCAL` behind a tunnel — config refuses it.

## DNS-rebinding / Host / Origin

`src/host-origin-guard.ts` + the transport's `enableDnsRebindingProtection`.

- `Host` must be present and in `ALLOWED_HOSTS`. A page resolving a domain to
  `127.0.0.1` sends that domain as `Host`; pinning blocks it. **Behind a tunnel
  the inbound `Host` is the tunnel domain — you must add it explicitly**, and
  binding to loopback no longer provides access control (auth becomes mandatory).
- `Origin`: absent is allowed (native clients omit it) but still token-gated; a
  **present-but-unrecognised** `Origin` → `403`.

For public tunnels, add a second access layer (Cloudflare Access, Tailscale
identity, etc.) and use a non-guessable subdomain. The tunnel URL is not a secret.

## Shell

`src/shell-tools.ts`. **Disabled unless `ENABLE_SHELL=1`** (the tool is not even
registered otherwise).

| Mode | Behaviour |
|---|---|
| `restricted` (default) | Allowlisted binary + subcommand only (read-only git set), denylist of code-exec/file-write flags. `shell:false`, argv array, scrubbed env, cwd pinned to the workspace, timeout → SIGKILL, output byte-capped. |
| `unrestricted` | Any binary (still argv-only, no shell). Gated behind `ALLOW_UNRESTRICTED_SHELL=1` **and** no `PUBLIC_BASE_URL`. Local-only escape hatch. |

`shell:false` makes command chaining (`;`, `|`, `&&`, `$()`, redirects, globs)
structurally impossible — those characters are passed literally.

**git config-driven execution is specifically neutralised.** git auto-reads
`.git/config` and `.gitattributes`, and keys like `core.fsmonitor`, external
diff/textconv drivers, hooks, and pager run arbitrary commands when an
*otherwise read-only* subcommand (`git status`/`diff`) runs — no `-c` flag
needed. Three layers close this: (1) every `git` invocation is prefixed with
server-controlled `-c` overrides (`core.fsmonitor=false`, `core.hooksPath=…`,
`core.pager=cat`, `core.sshCommand=`, `protocol.ext.allow=never`, …) that take
precedence over repo config, plus `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, and `--no-ext-diff
--no-textconv` injected into `diff`/`log`/`show` (the correct neutraliser — note
setting `diff.external=` *empty* does NOT disable it, it breaks `git diff`);
(2) the PathGuard **denies all writes into `.git/**` and to
`.gitattributes`/`.gitmodules`** (case-folded) so the model cannot plant the
config in the first place — enforced even when the shell is disabled; and (3) a
directory that is itself a **bare repo / git-dir is refused as an allowed root**
(its config/hooks live at the top level with no `.git/` prefix). A regression
smoke (`scripts/smoke-git-rce.mjs`) proves the RCE stays closed *and* that
`git diff` still works.

Timeouts and the output cap `SIGKILL` the whole **process group** (`detached` +
`process.kill(-pid)`), so a detached grandchild cannot survive the limit.

**Honest limitation:** a binary allowlist is workflow control, not a sandbox.
That is why interpreters (`npm`, `node`, `python`, `make`, `sh`) are **never**
allowlisted, and why the strong boundary for real command execution is a
container/sandbox wrapper (Roadmap). Do not add interpreters to the allowlist.

## Package installs

`src/package-tools.ts`. **Disabled unless `ENABLE_PACKAGE_INSTALL=1`**. This is
separate from shell and should stay separate: `install_packages` accepts
structured package-name arrays plus a `reason`, chooses `npm`/`pnpm`/`yarn`/`bun`
from `packageManager` or lockfiles, and injects flags that disable install
scripts (`--ignore-scripts` or Yarn's `--mode=skip-build`). It only allows
registry package names such as `react`, `react@latest`, or `@scope/pkg`; URLs,
tarballs, git specs, file paths, and duplicate entries are refused. The model is
expected to infer the minimal package list from the task and existing
`package.json`; the user reviews the tool call before approving it.

This still fetches third-party code and mutates `package.json` / lockfiles, so
enable it only for workspaces where that is expected. It is a safer workflow
tool, not a sandbox.

## Nx app scaffolding

`src/app-tools.ts`. **Disabled unless `ENABLE_APP_SCAFFOLD=1`**. `create_app`
defaults to `mode=isolated` and has two modes. `mode=existing` is a constrained
generator runner for healthy Nx monorepos: it verifies `package.json` and
`nx.json`, then runs one fixed Nx generator command for `@nx/next:app` or
`@nx/react:app` with argv-only process spawning and `--no-interactive`. It only
runs the workspace-local `node_modules/.bin/nx`; it does not use `npx`/`bunx`
and does not accept arbitrary command strings.

`mode=isolated` does not run Nx at all. It writes a constrained Nx + Next
workspace template under the opened workspace, defaulting to
`devspace-apps/<appName>`, and refuses symlinked parent directories or existing
targets. This is the safer choice for folders that contain many unrelated
projects or a broken Nx project graph. The generated workspace still needs a
package install before it can run.

`start_app_preview` is also gated by `ENABLE_APP_SCAFFOLD=1`. It installs
dependencies with lifecycle scripts disabled when needed, then starts the
workspace-local Nx dev server with fixed argv and proxies it through
`/app-previews/<previewId>/` for ChatGPT iframe rendering. Unlike static site
previews, this runs project code in a local dev server, so enable it only for
workspaces where running generated app code is expected.

## Search / regex (ReDoS)

`src/search-tools.ts`. Literal substring search is the default and is always
safe. Regex search is **opt-in** and never runs unbounded backtracking on the
main event loop (a single `(a+)+$` against an attacker-planted line would
otherwise freeze the whole single-process server). It is routed through the
linear-time **`re2`** engine; if `re2` is not installed the regex path is
**refused**, not run. Match input is additionally length-capped per line.

## Configuration: case-insensitive filesystems

`src/path-util.ts`. On case-insensitive volumes (default macOS APFS / Windows
NTFS) `realpath` preserves the *queried* casing, so a case-sensitive containment
check would let `ALLOWED_ROOTS=~/.SSH` slip past the secrets-dir rejection **and**
then serve every file under it. The shared containment helper detects filesystem
case-sensitivity once at startup and folds case accordingly — in both the config
gate and the live read/write boundary.

## Logging

`src/audit-log.ts`. Structured JSON to **stderr only** (stdout is the stdio MCP
channel). One line per tool call / auth event / rebind block. Never logged:
tokens, `Authorization`, file contents, diffs, env vars, full subprocess output.
Workspace ids are truncated; a regex backstop defangs stray bearer tokens.

## Configuration fail-closed

`src/config.ts` throws (never silently weakens) on:

- missing `ALLOWED_ROOTS`; a root that is `/`, your home, a parent of your home,
  or a secrets dir; a nonexistent / non-dir root.
- HTTP without auth unless `ALLOW_INSECURE_LOCAL=1` on loopback with no tunnel;
  a too-short `OWNER_TOKEN`; `HOST=0.0.0.0` without auth.
- `SHELL_MODE=unrestricted` without its gate, or together with a tunnel.
- `PUBLIC_BASE_URL` that isn't an https origin without a path.

## Enforce-in-code checklist (review gate)

Transport / network
- [ ] HTTP binds loopback; `0.0.0.0` requires auth and warns.
- [ ] Edge `hostOriginGuard` **and** transport DNS-rebinding both active.
- [ ] `ALLOWED_HOSTS` includes every host form clients send (+ the tunnel domain).
- [ ] Present-but-unknown `Origin` → 403; absent allowed but token-gated.
- [ ] Auth gates POST/GET/DELETE `/mcp`; metadata router stays unauthenticated.

Path containment
- [ ] Roots realpath'd at startup; `resolveForRead`/`resolveForWrite` enforced.
- [ ] `path.relative`-based containment (never bare `startsWith`).
- [ ] Reads `O_NOFOLLOW`+`fstat`; new writes `O_CREAT|O_EXCL|O_NOFOLLOW`.

Shell
- [ ] `shell:false` + argv everywhere; never a command string.
- [ ] Default disabled; allowlist constrains binary **and** args; no interpreters.
- [ ] Env scrubbed to an allowlist; timeout + output cap; cwd pinned.

Logging / deps
- [ ] No tokens / contents / env / full output in logs.
- [ ] `npm ci` with a committed lockfile; pinned deps; no global installs.

## Dependencies

Runtime: `@modelcontextprotocol/sdk`, `express`, `zod` (**pinned to v3** — the SDK
peer-deps zod 3.x; `npm i zod` would pull v4 and break tool typing), `fast-glob`,
`ignore`, `diff`. Optional: `re2` (linear-time regex engine — only needed for
regex search; literal search needs nothing). Install with the committed
`package-lock.json` (`npm ci`). `npm audit --omit=dev` is clean; the one
remaining advisory is a **dev-only** Windows esbuild issue pulled in by `vitest`
and never ships in the runtime path.
