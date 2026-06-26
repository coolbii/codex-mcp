import { afterEach, expect, it, vi } from "vitest";
import { createServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { SiteManager } from "../src/site-tools.js";
import { EditSessionManager } from "../src/edit-session-tools.js";
import { PathGuard } from "../src/path-guard.js";
import { makeApp } from "../src/http.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
let server: Server | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  await fx?.cleanup();
});

const silent = (): void => {};

function cfg(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    transport: "http",
    env: {
      ALLOWED_ROOTS: fx.root,
      OWNER_TOKEN: "x".repeat(40),
      PUBLIC_BASE_URL: "https://devspace.example.test",
      EDIT_SESSION_STORE_PATH: join(fx.base, "edit-sessions.json"),
      ...extra,
    },
    warn: silent,
  });
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}

it("persists edit sessions across a restart (reloads from disk)", async () => {
  fx = await makeFixture();
  const config = cfg();
  const created = await new EditSessionManager(config, new SiteManager(config, fx.guard)).createCanvasProject({
    title: "Persisted",
  });

  // Simulate a restart: a brand-new manager reading the same on-disk store.
  const afterRestart = new EditSessionManager(config, new SiteManager(config, fx.guard));
  const out = await afterRestart.scene(created.editSessionId); // throws "Unknown" if not persisted
  expect(out.session.editSessionId).toBe(created.editSessionId);
  expect(out.scene.version).toBe(1);
});

it("creates an editable canvas project and saves human edits as a new version", async () => {
  fx = await makeFixture();
  const config = cfg();
  const sites = new SiteManager(config, fx.guard);
  const edits = new EditSessionManager(config, sites);

  const created = await edits.createCanvasProject({ title: "Merchant Dashboard" });
  expect(created.previewUrl).toContain("/edit-sessions/");
  expect(created.sitePreviewUrl).toBe(`https://devspace.example.test/sites/${created.siteId}/`);
  expect(created.versions).toHaveLength(1);

  const saved = await edits.save(created.editSessionId, {
    scene: {
      version: 1,
      width: 1000,
      height: 640,
      background: "#ffffff",
      nodes: [{ id: "headline", type: "text", x: 40, y: 32, width: 420, height: 64, text: "Edited", fontSize: 32 }],
    },
  });

  expect(saved.site.versions).toHaveLength(2);
  const scene = JSON.parse(await readFile(join(saved.site.localPath, "scene.json"), "utf8")) as Record<string, any>;
  expect(scene.nodes[0].text).toBe("Edited");
  await expect(readFile(join(saved.site.localPath, "index.html"), "utf8")).resolves.toContain("Merchant Dashboard");
});

it("rejects unsafe scene paths for edit sessions", async () => {
  fx = await makeFixture();
  const config = cfg();
  const sites = new SiteManager(config, fx.guard);
  const edits = new EditSessionManager(config, sites);
  const project = await edits.createCanvasProject({ title: "Safe Canvas" });

  await expect(
    edits.createSession({ siteId: project.siteId, scenePath: "../escape.json" }),
  ).rejects.toThrow(/scenePath/i);
  await expect(
    edits.createSession({ siteId: project.siteId, scenePath: ".git/config.json" }),
  ).rejects.toThrow(/git|scenePath/i);
});

it("expires edit sessions", async () => {
  fx = await makeFixture();
  const config = cfg();
  const sites = new SiteManager(config, fx.guard);
  const edits = new EditSessionManager(config, sites);
  const project = await edits.createCanvasProject({ title: "Short Session", ttlSeconds: 60 });

  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  await expect(edits.scene(project.editSessionId)).rejects.toThrow(/expired/i);
});

it("requires the edit-session header before saving through the browser route", async () => {
  fx = await makeFixture();
  const port = await freePort();
  const config = cfg({
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    HOST: "127.0.0.1",
    PORT: String(port),
  });
  const app = makeApp(config, new PathGuard(config.allowedRoots));
  const edits = app.locals.editSessionManager as EditSessionManager;
  const project = await edits.createCanvasProject({ title: "Route Save" });

  await new Promise<void>((resolve) => {
    server = app.listen(port, "127.0.0.1", () => resolve());
  });

  const editorPage = await (await fetch(`http://127.0.0.1:${port}/edit-sessions/${project.editSessionId}/`)).text();
  const scripts = [...editorPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    expect(() => new Function(script)).not.toThrow();
  }
  expect(editorPage).not.toContain("delete.onclick");

  const missingHeader = await fetch(`http://127.0.0.1:${port}/edit-sessions/${project.editSessionId}/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scene: { version: 1, nodes: [] } }),
  });
  expect(missingHeader.status).toBe(403);

  const ok = await fetch(`http://127.0.0.1:${port}/edit-sessions/${project.editSessionId}/save`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-devspace-edit-session": project.editSessionId,
    },
    body: JSON.stringify({ scene: { version: 1, nodes: [] } }),
  });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { latestVersion?: string };
  expect(body.latestVersion).toBeTruthy();
});
