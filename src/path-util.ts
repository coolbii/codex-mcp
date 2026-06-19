/**
 * path-util.ts — case-correct path containment.
 *
 * THE BUG THIS FIXES: node's `realpath` preserves the *queried* casing rather
 * than the on-disk casing, and `path.relative` is case-sensitive. On a
 * case-INSENSITIVE volume (default macOS APFS, default Windows NTFS), that means
 * `~/.SSH` and `~/.ssh` are the SAME directory but compare as different strings.
 * A case-sensitive containment check therefore (a) lets `ALLOWED_ROOTS=~/.SSH`
 * slip past the secrets-dir rejection, and (b) then serves every file under it,
 * because the same helper is the read/write boundary. Fail-open. Bad.
 *
 * FIX: detect filesystem case-sensitivity once, and fold case in the comparison
 * when (and only when) the volume is case-insensitive. On a genuinely
 * case-sensitive volume we keep exact comparison (folding there would be the
 * inverse mistake — merging two distinct directories).
 */
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { isAbsolute, relative, basename, dirname, join } from "node:path";

function toggleFirstAlphaCase(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c >= "a" && c <= "z") return s.slice(0, i) + c.toUpperCase() + s.slice(i + 1);
    if (c >= "A" && c <= "Z") return s.slice(0, i) + c.toLowerCase() + s.slice(i + 1);
  }
  return null;
}

/**
 * Probe the filesystem: if a case-toggled form of the home directory resolves to
 * the same inode, the volume is case-insensitive. If it does not exist, the
 * volume is case-sensitive. Falls back to a platform default only if the probe
 * is inconclusive (e.g. home has no alphabetic character).
 */
function detectCaseInsensitive(): boolean {
  try {
    const home = homedir();
    const name = basename(home);
    const toggled = toggleFirstAlphaCase(name);
    if (toggled && toggled !== name) {
      const parent = dirname(home);
      let toggledStat;
      try {
        toggledStat = statSync(join(parent, toggled));
      } catch {
        return false; // toggled name does not exist ⇒ case-sensitive volume
      }
      const realStat = statSync(join(parent, name));
      return realStat.ino === toggledStat.ino && realStat.dev === toggledStat.dev;
    }
  } catch {
    /* fall through to platform default */
  }
  return process.platform === "darwin" || process.platform === "win32";
}

/** Resolved once at startup. */
export const CASE_INSENSITIVE_FS = detectCaseInsensitive();

function fold(p: string): string {
  // On case-insensitive volumes also normalise Unicode: APFS/NTFS are
  // normalisation-insensitive, so the same name can arrive as NFC or NFD (e.g.
  // "café" composed vs decomposed). Without NFC the containment check would
  // produce false negatives (legit path wrongly judged outside). We only fold +
  // normalise here; on case-SENSITIVE volumes comparison stays byte-exact.
  return CASE_INSENSITIVE_FS ? p.normalize("NFC").toLowerCase() : p;
}

/**
 * True if `child` is `parent` or lives under it, honouring filesystem case
 * semantics. Uses `path.relative` (never a bare `startsWith`) so that
 * `/a/foobar` is NOT considered inside `/a/foo`.
 */
export function isInsideOrEqual(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
