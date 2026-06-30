/**
 * extract-reference.ts — pull real design tokens from a public reference page.
 *
 * This closes the "reference is hallucinated" gap: instead of the model inventing
 * a brand's palette/type/spacing from memory, a headless browser loads the page,
 * screenshots it, and reads COMPUTED styles to derive a concrete token set
 * (colors, type scale, weights, spacing rhythm, radii, CSS variables).
 *
 * It is a NARROW, purpose-built tool (fixed behavior), not a general fetch/shell.
 * Because it makes the server fetch an operator-/model-supplied URL, it is guarded
 * against SSRF: only http/https, and the resolved host plus every sub-request host
 * must be a public address (private/loopback/link-local/metadata ranges blocked).
 *
 * Playwright is an OPTIONAL dependency, loaded lazily like @resvg/resvg-js.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ExtractReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractReferenceError";
  }
}

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map((n) => parseInt(n, 10));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true; // link-local / ULA
    if (l.startsWith("::ffff:")) return ipIsPrivate(ip.slice(ip.lastIndexOf(":") + 1)); // v4-mapped
    return false;
  }
  return true; // not a valid IP literal -> treat as unsafe
}

function hostnameLooksPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) && ipIsPrivate(h)) return true;
  return false;
}

/** Validate scheme + resolve the host and reject private/loopback/metadata targets. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractReferenceError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractReferenceError("Only http(s) URLs are allowed");
  }
  if (hostnameLooksPrivate(url.hostname)) {
    throw new ExtractReferenceError(`Refusing to fetch a private/loopback host: ${url.hostname}`);
  }
  if (!isIP(url.hostname)) {
    let resolved: { address: string }[];
    try {
      resolved = await lookup(url.hostname, { all: true });
    } catch {
      throw new ExtractReferenceError(`Could not resolve host: ${url.hostname}`);
    }
    if (resolved.length === 0 || resolved.some((r) => ipIsPrivate(r.address))) {
      throw new ExtractReferenceError(`Host resolves to a private/blocked address: ${url.hostname}`);
    }
  }
  return url;
}

export interface ColorCount {
  color: string;
  count: number;
}

export interface ExtractReferenceResult {
  url: string;
  finalUrl: string;
  title: string;
  screenshotBase64: string;
  colors: ColorCount[];
  backgrounds: ColorCount[];
  fontFamilies: string[];
  typeScale: number[];
  fontWeights: number[];
  spacing: number[];
  radii: number[];
  cssVariables: Record<string, string>;
}

/**
 * Browser-side token harvester. Runs in the page via page.evaluate, so it must be
 * self-contained and source DOM globals from globalThis (the Node tsconfig has no
 * DOM lib). Returns a JSON-serializable token bag.
 */
/* c8 ignore start */
function harvestTokens(): {
  colors: ColorCount[];
  backgrounds: ColorCount[];
  fontFamilies: string[];
  typeScale: number[];
  fontWeights: number[];
  spacing: number[];
  radii: number[];
  cssVariables: Record<string, string>;
} {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const g = globalThis as any;
  const doc = g.document;
  const gcs = (el: any): any => g.getComputedStyle(el);
  const tally = (map: Map<string, number>, key: string | undefined): void => {
    if (!key) return;
    const k = key.trim().toLowerCase();
    if (!k || k === "rgba(0, 0, 0, 0)" || k === "transparent" || k === "none") return;
    map.set(k, (map.get(k) ?? 0) + 1);
  };
  const top = (map: Map<string, number>, n: number): ColorCount[] =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([color, count]) => ({ color, count }));

  const colors = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const families = new Map<string, number>();
  const sizes = new Set<number>();
  const weights = new Set<number>();
  const spacings = new Set<number>();
  const radii = new Set<number>();

  const els = Array.from(doc.querySelectorAll("body *")).slice(0, 6000) as any[];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = gcs(el);
    const hasText = (el.textContent ?? "").trim().length > 0 && el.children.length === 0;
    if (hasText) {
      tally(colors, cs.color);
      const fs = parseFloat(cs.fontSize);
      if (fs) sizes.add(Math.round(fs));
      const fw = parseInt(cs.fontWeight, 10);
      if (fw) weights.add(fw);
      const fam = cs.fontFamily?.split(",")[0]?.replace(/["']/g, "").trim();
      if (fam) families.set(fam, (families.get(fam) ?? 0) + 1);
    }
    tally(backgrounds, cs.backgroundColor);
    for (const v of [cs.paddingTop, cs.paddingLeft, cs.marginTop, cs.gap]) {
      const n = parseFloat(v);
      if (n && n <= 160) spacings.add(Math.round(n));
    }
    const rad = parseFloat(cs.borderTopLeftRadius);
    if (rad && rad <= 200) radii.add(Math.round(rad));
  }

  const cssVariables: Record<string, string> = {};
  const rootCs = gcs(doc.documentElement);
  for (let i = 0; i < rootCs.length; i++) {
    const prop: string = rootCs.item(i);
    if (prop.startsWith("--")) {
      const val = rootCs.getPropertyValue(prop).trim();
      if (val && Object.keys(cssVariables).length < 80) cssVariables[prop] = val.slice(0, 80);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    colors: top(colors, 10),
    backgrounds: top(backgrounds, 10),
    fontFamilies: [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([f]) => f),
    typeScale: [...sizes].sort((a, b) => a - b),
    fontWeights: [...weights].sort((a, b) => a - b),
    spacing: [...spacings].sort((a, b) => a - b),
    radii: [...radii].sort((a, b) => a - b),
    cssVariables,
  };
}
/* c8 ignore stop */

let pwModule: unknown = null;
let pwLoaded = false;
async function loadPlaywright(): Promise<{ chromium: { launch(opts?: unknown): Promise<unknown> } }> {
  if (!pwLoaded) {
    pwLoaded = true;
    try {
      const spec = "playwright"; // non-literal: keep it an optional runtime dep
      pwModule = await import(spec);
    } catch {
      pwModule = null;
    }
  }
  if (!pwModule) {
    throw new ExtractReferenceError(
      "playwright is not installed. Run `npm install playwright --save-optional && npx playwright install chromium`.",
    );
  }
  return pwModule as { chromium: { launch(opts?: unknown): Promise<unknown> } };
}

export interface ExtractReferenceInput {
  url: string;
  viewportWidth?: number;
  fullPage?: boolean;
  timeoutMs?: number;
}

/** Load a public reference page headlessly and harvest its design tokens + screenshot. */
export async function extractDesignReference(input: ExtractReferenceInput): Promise<ExtractReferenceResult> {
  const url = await assertSafeUrl(input.url);
  const width = input.viewportWidth ?? 1440;
  if (!Number.isInteger(width) || width < 320 || width > 3840) {
    throw new ExtractReferenceError("viewportWidth must be between 320 and 3840");
  }
  const timeout = input.timeoutMs ?? 20_000;
  const { chromium } = await loadPlaywright();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser: any = await chromium.launch({ headless: true });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await context.newPage();
    // Block sub-requests to private hosts (covers redirects / SSRF via assets).
    await page.route("**/*", (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => {
      try {
        const h = new URL(route.request().url()).hostname;
        if (hostnameLooksPrivate(h)) return route.abort();
      } catch {
        return route.abort();
      }
      return route.continue();
    });
    const resp = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout });
    if (resp && hostnameLooksPrivate(new URL(resp.url()).hostname)) {
      throw new ExtractReferenceError("Navigation redirected to a private host");
    }
    await page.waitForTimeout(Math.min(2500, timeout / 4)); // let web fonts / CSS settle
    const title: string = (await page.title().catch(() => "")) || url.hostname;
    // Some bundlers (esbuild/tsx --keepNames) instrument functions with a __name()
    // helper; define it in the page so the serialized harvester runs there.
    await page.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; };");
    const tokens = (await page.evaluate(harvestTokens)) as Omit<
      ExtractReferenceResult,
      "url" | "finalUrl" | "screenshotBase64" | "title"
    >;
    const shotBuf: Buffer = await page.screenshot({ fullPage: input.fullPage ?? false, type: "png" });
    return {
      url: input.url,
      finalUrl: page.url(),
      title: title.slice(0, 200),
      screenshotBase64: shotBuf.toString("base64"),
      ...tokens,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export { assertSafeUrl, ipIsPrivate, hostnameLooksPrivate };
