import { afterEach, expect, it } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SecretGuard } from "../src/secret-guard.js";
import { findFiles, searchFiles } from "../src/search-tools.js";
import { makeFixture, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

it("flags credential file paths and leaves normal files alone", () => {
  const g = new SecretGuard();
  for (const p of [
    ".env",
    ".env.local",
    "config/.env.production",
    "id_rsa",
    "keys/server.pem",
    "app.key",
    "secrets.yml",
    "aws-credentials.json",
    ".ssh/config",
    ".aws/credentials",
    ".npmrc",
    ".git-credentials",
    ".ccb/agents/codex/state.json",
    ".docker/config.json",
    ".gemini/oauth_creds.json",
    "data/devspace-oauth.json",
    "okx-bot/secrets/mtls/cert.p12",
    "secrets/okx-keys.json", // file UNDER a secrets/ dir (Codex finding 3)
    "config/credentials/app.conf",
    ".env ", // trailing space (Windows alias, Codex finding 6)
    ".env.", // trailing dot
  ]) {
    expect(g.isSecretPath(p), p).toBe(true);
  }
  for (const p of ["index.html", "src/app.ts", "README.md", "styles.css", "data/users.json"]) {
    expect(g.isSecretPath(p), p).toBe(false);
  }
});

it("honors extra DENY_PATHS glob patterns including **/ at any depth", () => {
  const g = new SecretGuard({ extraDenyPatterns: ["**/private/**", "*.token", "**/vault/**"] });
  expect(g.isSecretPath("src/private/notes.md")).toBe(true);
  expect(g.isSecretPath("session.token")).toBe(true);
  // "**/vault/**" must also match a top-level "vault/..." (zero leading dirs).
  expect(g.isSecretPath("vault/key.txt")).toBe(true);
  expect(g.isSecretPath("a/b/vault/key.txt")).toBe(true);
  expect(g.isSecretPath("src/public/notes.md")).toBe(false);
});

it("redacts high-confidence secrets and secret-ish assignments", () => {
  const g = new SecretGuard();

  const pk = g.redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEdummy\n-----END RSA PRIVATE KEY-----");
  expect(pk.redactions).toBeGreaterThan(0);
  expect(pk.text).not.toContain("BEGIN RSA PRIVATE KEY");

  const aws = g.redact("aws_key = AKIAIOSFODNN7EXAMPLE");
  expect(aws.text).toContain("[redacted");
  expect(aws.text).not.toContain("AKIAIOSFODNN7EXAMPLE");

  const gh = g.redact("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(gh.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const j = g.redact(`const t = '${jwt}'`);
  expect(j.text).not.toContain(jwt);

  const assign = g.redact("API_KEY=supersecretvalue123");
  expect(assign.redactions).toBeGreaterThan(0);
  expect(assign.text).toContain("API_KEY=");
  expect(assign.text).not.toContain("supersecretvalue123");

  // PEM BODY (not just the BEGIN marker) must be redacted.
  const pem = g.redact("a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaSECRETBODY\nmoremoremore\n-----END OPENSSH PRIVATE KEY-----\nb");
  expect(pem.text).not.toContain("AAAAB3NzaSECRETBODY");
  expect(pem.text).not.toContain("moremoremore");

  // Quoted JSON secret and PASSPHRASE keyword.
  expect(g.redact('{"apiSecret": "abcd1234efgh5678"}').text).not.toContain("abcd1234efgh5678");
  expect(g.redact("DB_PASSPHRASE=my-super-secret-pass").text).not.toContain("my-super-secret-pass");
});

it("redacts a long secret in search results BEFORE clipping the line", async () => {
  fx = await makeFixture();
  const longval = "x".repeat(500);
  await writeFile(join(fx.root, "conf.txt"), `API_KEY=${longval}\n`, "utf8");
  const g = new SecretGuard();
  const r = await searchFiles(fx.guard, fx.ws, {
    query: "API_KEY",
    maxResults: 10,
    maxFileBytes: 1_000_000,
    redactLine: (line) => g.redact(line).text,
  });
  expect(r.matches.length).toBeGreaterThan(0);
  expect(r.matches[0]!.line).toContain("[redacted");
  expect(r.matches[0]!.line).not.toContain("xxxxxxxxxxxxxxxxxxxx"); // no secret tail survived
});

it("leaves ordinary content untouched and respects scanContent=false", () => {
  const g = new SecretGuard();
  const plain = "function add(a, b) {\n  return a + b;\n}\n";
  expect(g.redact(plain)).toEqual({ text: plain, redactions: 0 });

  const off = new SecretGuard({ scanContent: false });
  const r = off.redact("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(r.redactions).toBe(0);
});

it("excludes credential files from find_files via excludePath", async () => {
  fx = await makeFixture();
  await mkdir(join(fx.root, "config"), { recursive: true });
  await writeFile(join(fx.root, "index.html"), "<h1>hi</h1>", "utf8");
  await writeFile(join(fx.root, ".env"), "SECRET=x", "utf8");
  await writeFile(join(fx.root, "config", "credentials.json"), "{}", "utf8");

  const g = new SecretGuard();
  const r = await findFiles(fx.guard, fx.ws, "**/*", {
    includeDotfiles: true,
    respectGitignore: false,
    excludePath: (rel) => g.isSecretPath(rel),
  });
  expect(r.files).toContain("index.html");
  expect(r.files).not.toContain(".env");
  expect(r.files.some((f) => f.endsWith("credentials.json"))).toBe(false);
});
