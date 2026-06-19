import { it, expect } from "vitest";
import { isInsideOrEqual, CASE_INSENSITIVE_FS } from "../src/path-util.js";

it("treats a directory as inside itself", () => {
  expect(isInsideOrEqual("/a/b", "/a/b")).toBe(true);
});

it("treats a child as inside its parent", () => {
  expect(isInsideOrEqual("/a/b/c", "/a/b")).toBe(true);
});

it("rejects sibling-prefix false positives (/a/foobar vs /a/foo)", () => {
  expect(isInsideOrEqual("/a/foobar", "/a/foo")).toBe(false);
});

it("rejects an unrelated path", () => {
  expect(isInsideOrEqual("/a/x", "/a/b")).toBe(false);
});

it("treats NFC and NFD forms of the same name as equal on case-insensitive FS", () => {
  if (!CASE_INSENSITIVE_FS) return; // byte-exact on case-sensitive volumes
  const composed = "caf" + String.fromCharCode(0x00e9); // café  (é = U+00E9, NFC)
  const decomposed = "cafe" + String.fromCharCode(0x0301); // café (e + U+0301, NFD)
  expect(composed).not.toBe(decomposed); // genuinely different byte sequences
  expect(isInsideOrEqual(`/root/${composed}/x`, `/root/${decomposed}`)).toBe(true);
});

it("folds case to match the filesystem's case sensitivity", () => {
  // On a case-INSENSITIVE volume (default macOS/Windows) /A/B is the same place
  // as /a/b, so it must be considered inside /a. On a case-SENSITIVE volume it
  // must not. Either way the result must match the detected FS behaviour —
  // this is exactly the property that stops ALLOWED_ROOTS=~/.SSH from slipping
  // past the secrets-dir check.
  expect(isInsideOrEqual("/A/B", "/a")).toBe(CASE_INSENSITIVE_FS);
});
