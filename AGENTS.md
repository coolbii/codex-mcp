# AGENTS.md — rules for AI agents working on this repo

This is a **security tool**: a self-hosted MCP server that exposes local files
(and an optional shell) to an AI client. Security is the product, not a feature.
Read [docs/security.md](docs/security.md) before changing anything in `src/`.

## Non-negotiables

- **Never weaken the PathGuard.** All filesystem access goes through
  `src/path-guard.ts` (`resolveForRead`/`resolveForWrite`). A new tool MUST route
  every path through it against the tool's workspace root. Do not add a code path
  that opens a model-supplied path directly.
- **Shell stays OFF by default.** Do not register `run_command` unless
  `config.enableShell`. Do not add interpreters (`npm`, `node`, `python`, `make`,
  `sh`, `bash`) to the restricted allowlist — they execute arbitrary repo code.
  Keep `shell:false` and argv arrays; never build a command string or set
  `shell:true`.
- **Never log secrets.** Diagnostics go to **stderr** via `src/audit-log.ts`
  (stdout is the stdio protocol channel). Never log tokens, `Authorization`,
  file contents, diffs, env vars, or full subprocess output.
- **Fail closed.** Config validation throws on anything unsafe. Don't add a
  default that silently weakens security; add a throwing check instead.
- **Keep tests green.** `npm test` (64 tests) must pass before any commit, and
  `npm run typecheck` must be clean. Add tests for new security-relevant code —
  especially anything touching paths, auth, or the shell.

## How to add a tool safely

1. Write a pure function in a `*-tools.ts` module that takes `(guard, ws, …)` and
   uses the `PathGuard` for every path. No MCP/SDK imports there.
2. Register it in `src/mcp-server.ts` with a zod **raw-shape** `inputSchema`
   (`{ key: z.string() }`, not `z.object(...)`) and honest annotations:
   `readOnlyHint: true` for read-only tools, `destructiveHint: true` for writes.
   ChatGPT uses these to decide whether to prompt for approval.
3. Wrap the body in the existing `invoke()` helper so it is timed, audited, and
   converts thrown errors to `isError` results.
4. Add unit tests (`tests/`) including a negative test that an escape/abuse is
   rejected.

## Security fixes that must not regress

These came out of an adversarial review and have regression tests/smokes. Don't
remove them:

- **git on-disk-config RCE.** `git` is invoked with `GIT_HARDENING_ARGS` (`-c`
  overrides for `core.fsmonitor`/hooks/pager/diff/ssh) + `GIT_CONFIG_NOSYSTEM`/
  `GIT_CONFIG_GLOBAL`/`GIT_ATTR_NOSYSTEM`, and the PathGuard denies writes into
  `.git/**` and to `.gitattributes`/`.gitmodules`. Keep both. Proof:
  `scripts/smoke-git-rce.mjs`.
- **ReDoS.** Regex search goes through `re2` (linear time) or is refused — never
  feed an untrusted pattern to `RegExp` on the main thread.
- **Case-insensitive FS.** Path containment uses `src/path-util.ts`
  (`isInsideOrEqual`), which folds case on case-insensitive volumes. Don't
  reintroduce a case-sensitive `path.relative` check in config.ts/path-guard.ts.
- **Process-group kill.** The shell timeout/output-cap kill the whole group
  (`detached` + `process.kill(-pid)`).

## Layered-defense rule

Defenses are deliberately redundant. When in doubt, **add** a check; do not
remove one because "another layer already covers it." Example: the search tool
re-validates every `fast-glob` result through the `PathGuard`; both the edge
`Host`/`Origin` guard and the SDK transport's DNS-rebinding option run.

## Dependency hygiene

- `zod` is pinned to **v3** on purpose (the MCP SDK peer-deps zod 3.x; v4 breaks
  tool typing). Do not bump it to v4.
- Use the official `@modelcontextprotocol/sdk` **1.x** subpath imports
  (`@modelcontextprotocol/sdk/server/*.js`). The 2.0-alpha import paths
  (`@modelcontextprotocol/server/*`) are not on npm — do not use them.
- Install with `npm ci` (committed lockfile). No global installs of untrusted
  packages.

## Known status / roadmap (don't "fix" these as bugs)

- **ChatGPT** doesn't work with owner-token auth (it can't send a custom bearer
  header). The intended fix is an OAuth 2.1 + PKCE proxy milestone, not disabling
  auth. Never route a tunnel to an `ALLOW_INSECURE_LOCAL` server.
- **TOCTOU** on intermediate path components is a documented residual of pure
  Node; the strong closure is a container/sandbox shell mode (roadmap).
- **Command allowlist** is workflow control, not a sandbox — by design.
