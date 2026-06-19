/**
 * audit-log.ts — structured, secret-free audit logging.
 *
 * CRITICAL: logs go to STDERR, never stdout. For the stdio transport, stdout
 * is the MCP JSON-RPC channel; a stray console.log there corrupts the
 * protocol. Always use this module (or process.stderr) for diagnostics.
 *
 * We log enough to audit (who called what, on which workspace, did it
 * succeed, how long) but never enough to leak:
 *   - no tokens (owner token, bearer tokens, Authorization headers)
 *   - no file contents
 *   - no environment variables
 *   - no shell output (unless LOG_SHELL_COMMANDS is explicitly on, and even
 *     then only a length-capped preview the operator opted into)
 *
 * Workspace IDs are truncated to a short prefix so logs cannot be used to
 * replay a full workspace handle.
 */

export type AuditEvent =
  | "tool_call"
  | "tool_error"
  | "auth_ok"
  | "auth_fail"
  | "rebind_block"
  | "session_open"
  | "session_close"
  | "server_start"
  | "shell_exec";

export interface AuditFields {
  event: AuditEvent;
  tool?: string;
  workspaceId?: string;
  /** A workspace-relative path is fine to log; absolute host paths are not. */
  path?: string;
  success?: boolean;
  durationMs?: number;
  /** Short, non-sensitive reason/message. Never raw content. */
  detail?: string;
  /** Remote address / host for HTTP requests. */
  remote?: string;
  [extra: string]: unknown;
}

const SECRET_KEY_RE = /token|secret|password|passphrase|authorization|cookie|api[-_]?key/i;

/** Recursively scrub anything that looks like a secret before serialising. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limited]";
  if (value == null) return value;
  if (typeof value === "string") {
    // Defang obvious bearer tokens that slipped into a free-text field.
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]");
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

function shortId(id: string | undefined): string | undefined {
  if (!id) return id;
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

let timeSource: () => string = () => new Date().toISOString();

/** Test seam: override the timestamp source (production uses ISO now). */
export function setTimeSource(fn: () => string): void {
  timeSource = fn;
}

export function audit(fields: AuditFields): void {
  const record = {
    ts: timeSource(),
    ...((scrub(fields) as Record<string, unknown>) ?? {}),
    workspaceId: shortId(fields.workspaceId),
  };
  try {
    process.stderr.write(JSON.stringify(record) + "\n");
  } catch {
    // Never let logging throw into the request path.
  }
}
