import { describe, expect, it } from "vitest";
import { assertSafeUrl, ipIsPrivate, hostnameLooksPrivate, ExtractReferenceError } from "../src/extract-reference.js";

describe("extract-reference SSRF guard", () => {
  it("flags private / loopback / metadata IPs and trusts public ones", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "100.64.0.1", "0.0.0.0"]) {
      expect(ipIsPrivate(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(ipIsPrivate(ip), ip).toBe(false);
    }
  });

  it("flags private-looking hostnames", () => {
    for (const h of ["localhost", "foo.localhost", "db.local", "svc.internal", "127.0.0.1", "10.1.2.3"]) {
      expect(hostnameLooksPrivate(h), h).toBe(true);
    }
    for (const h of ["illoca.com", "stripe.com", "example.com", "8.8.8.8"]) {
      expect(hostnameLooksPrivate(h), h).toBe(false);
    }
  });

  it("rejects non-http schemes and private hosts without DNS", async () => {
    await expect(assertSafeUrl("ftp://example.com")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("http://localhost:7676/mcp")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toBeInstanceOf(ExtractReferenceError);
    await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(ExtractReferenceError);
  });

  it("accepts a public IP-literal http(s) URL", async () => {
    await expect(assertSafeUrl("https://8.8.8.8/")).resolves.toMatchObject({ protocol: "https:" });
  });
});
