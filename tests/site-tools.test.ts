import { afterEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadConfig } from "../src/config.js";
import { SiteManager } from "../src/site-tools.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

const silent = (): void => {};

function manager(): SiteManager {
  const cfg = loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      PUBLIC_BASE_URL: "https://devspace.example.test",
    },
    warn: silent,
  });
  return new SiteManager(cfg, fx.guard);
}

it("creates a versioned static site with a public preview URL", async () => {
  fx = await makeFixture();
  const sites = manager();

  const site = await sites.createSite({ title: "Landing Page", prompt: "A focused landing page" });

  expect(site.siteId).toMatch(/^landing-page-/);
  expect(site.previewUrl).toBe(`https://devspace.example.test/sites/${site.siteId}/`);
  expect(site.versions).toHaveLength(1);
  expect(site.latestVersion).toBe(site.versions[0]?.version);

  const preview = await sites.previewFile(site.siteId, "");
  expect(basename(preview.absolutePath)).toBe("index.html");
  expect(preview.contentType).toMatch(/text\/html/);
  await expect(readFile(preview.absolutePath, "utf8")).resolves.toContain("Landing Page");
});

it("creates an archetype-based site without custom HTML", async () => {
  fx = await makeFixture();
  const sites = manager();

  const site = await sites.createSite({
    title: "Ops Console",
    prompt: "Internal operations workspace",
    archetype: "internal-dashboard",
  });

  expect(site.archetype).toBe("internal-dashboard");
  const preview = await sites.previewFile(site.siteId, "");
  const html = await readFile(preview.absolutePath, "utf8");
  expect(html).toContain("Operations console");
  expect(html).toContain("app-shell");
});

it("commits each meaningful site update", async () => {
  fx = await makeFixture();
  const sites = manager();
  const created = await sites.createSite({ title: "Docs", prompt: "Docs site" });

  const updated = await sites.updateSite({
    siteId: created.siteId,
    message: "Change headline",
    html: "<!doctype html><title>Docs v2</title><h1>Docs v2</h1>",
  });

  expect(updated.versions).toHaveLength(2);
  expect(updated.versions[0]?.message).toBe("Change headline");
});

it("normalizes incomplete model-provided HTML into a complete document", async () => {
  fx = await makeFixture();
  const sites = manager();
  const site = await sites.createSite({
    title: "Partial",
    prompt: "Recover from partial HTML",
    html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partial</title>',
  });

  const preview = await sites.previewFile(site.siteId, "");
  const html = await readFile(preview.absolutePath, "utf8");
  expect(html).toContain("</head>");
  expect(html).toContain("<body>");
  expect(html).toContain("</body>");
  expect(html).toContain("</html>");
});

it("refuses path traversal when serving previews", async () => {
  fx = await makeFixture();
  const sites = manager();
  const site = await sites.createSite({ title: "Safe Site", prompt: "Safety" });

  await expect(sites.previewFile(site.siteId, "../.env")).rejects.toThrow(/traversal|escapes/i);
  await expect(sites.previewFile(site.siteId, ".git/config")).rejects.toThrow(/git/i);
});
