/**
 * host-origin-guard.ts — edge defense against DNS-rebinding / cross-origin.
 *
 * This runs IN ADDITION to the SDK transport's own
 * `enableDnsRebindingProtection` (belt and suspenders), because that option is
 * marked @deprecated in SDK 1.29.0 and is removed in the 2.0 line. Keeping our
 * own guard means the protection survives the eventual SDK upgrade.
 *
 * Rules:
 *   - Host header MUST be present and in the allowlist. A malicious web page
 *     that resolves some domain to 127.0.0.1 will send that domain as Host;
 *     pinning Host blocks it. Behind a tunnel, the tunnel domain must be in the
 *     allowlist explicitly.
 *   - Origin: browsers always send it; native MCP clients (Claude Desktop, CLI)
 *     omit it. So: absent Origin is allowed (still token-gated); a PRESENT but
 *     unrecognised Origin is hostile ⇒ 403.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { audit } from "./audit-log.js";

export function hostOriginGuard(
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): RequestHandler {
  const hosts = new Set(allowedHosts);
  const origins = new Set(allowedOrigins);

  return (req: Request, res: Response, next: NextFunction): void => {
    const host = req.headers.host;
    if (!host || !hosts.has(host)) {
      audit({ event: "rebind_block", detail: "host", remote: req.ip, success: false });
      res.status(403).json({ error: "host_not_allowed" });
      return;
    }

    const origin = req.headers.origin;
    if (origin !== undefined && origins.size > 0 && !origins.has(origin)) {
      audit({ event: "rebind_block", detail: "origin", remote: req.ip, success: false });
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }

    next();
  };
}
