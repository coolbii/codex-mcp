/**
 * secret-guard.ts -- defense-in-depth secret protection for the READ surface.
 *
 * Two layers, both advisory-but-enforced (the hard boundary is still
 * ALLOWED_ROOTS; this stops a cooperative *or* injected model from surfacing
 * credentials that happen to live inside an allowed root):
 *
 *   1. Filename/path denylist (the guarantee). Built-in patterns cover the
 *      common credential files; the operator can extend via DENY_PATHS. A
 *      denied path is refused outright by read_file and never appears in
 *      find_files / search_files.
 *
 *   2. Content fingerprinting (the net). High-confidence signatures (private
 *      keys, cloud/token prefixes, JWTs) and a secret-ish KEY=value heuristic
 *      are redacted from any content we DO return. This is best-effort: it can
 *      false-positive and can miss exotic encodings -- never rely on it alone.
 */

// --- layer 1: filename / path patterns -------------------------------------

const BUILTIN_NAME_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i, // .env, .env.local, .env.production ...
  /(^|\/)\.envrc$/i,
  /(^|\/)\.flaskenv$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.pkcs12$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.ppk$/i,
  /\.asc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)(service-account|gcloud-key|serviceaccount)[^/]*\.json$/i,
  /(^|[._/-])credentials([._-][^/]*)?$/i, // credentials, aws-credentials, credentials.json
  /(^|[._/-])secrets?([._-][^/]*)?$/i, // secret, secrets.yml, app-secret.txt
];

// --- layer 2: content signatures -------------------------------------------

const CONTENT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, label: "private-key" },
  { re: /\bA(?:KIA|SIA|GPA|IDA|ROA|IPA|NPA|NVA)[0-9A-Z]{16}\b/g, label: "aws-key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: "github-token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "github-pat" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
  { re: /\bsk_live_[A-Za-z0-9]{16,}\b/g, label: "stripe-key" },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: "google-api-key" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: "llm-api-key" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, label: "jwt" },
];

// Secret-ish assignment: NAME = value, where NAME looks like a credential.
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH)[A-Za-z0-9_]*)\s*([:=])\s*(['"]?)([^\s'"#]{6,})\3/gi;

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

/** Translate a simple glob (`*`, `**`, `?`) into a case-insensitive RegExp.
 *  `**` matches across path separators, `*` within a segment, `?` one char. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += ".";
    } else if (REGEX_SPECIAL.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out, "i");
}

export class SecretGuard {
  private readonly namePatterns: RegExp[];
  private readonly scanContent: boolean;

  constructor(opts: { extraDenyPatterns?: string[]; scanContent?: boolean } = {}) {
    const extra = (opts.extraDenyPatterns ?? []).map(globToRegExp);
    this.namePatterns = [...BUILTIN_NAME_PATTERNS, ...extra];
    this.scanContent = opts.scanContent ?? true;
  }

  /** True if this workspace-relative path is a credential file we must not read. */
  isSecretPath(relPath: string): boolean {
    const p = relPath.replace(/\\/g, "/");
    return this.namePatterns.some((re) => re.test(p));
  }

  /** Standard refusal text returned in place of a denied read (doubles as a
   *  prompt: it tells the model to ask the user for the value, not work around). */
  blockMessage(relPath: string): string {
    return (
      `Blocked: "${relPath}" looks like a secret/credential file and is off-limits. ` +
      `Do not try alternate paths or encodings to read it. If you need a specific value, ` +
      `ask the user to paste just that value.`
    );
  }

  /** Redact high-confidence secrets from text we are about to return. Returns
   *  the (possibly) redacted text and the number of redactions made. */
  redact(text: string): { text: string; redactions: number } {
    if (!this.scanContent || !text) return { text, redactions: 0 };
    let count = 0;
    let out = text;
    for (const { re, label } of CONTENT_PATTERNS) {
      out = out.replace(re, () => {
        count++;
        return `[redacted:${label}]`;
      });
    }
    out = out.replace(ASSIGNMENT_PATTERN, (_m, name: string, op: string, q: string) => {
      count++;
      return `${name}${op}${q}[redacted:secret]${q}`;
    });
    return { text: out, redactions: count };
  }
}
