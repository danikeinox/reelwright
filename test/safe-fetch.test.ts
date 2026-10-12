import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBlockedAddress, safeFetchText, UnsafeUrlError } from "../src/security/safe-fetch.js";
import { json, startServer } from "./helpers.js";

describe("isBlockedAddress", () => {
  const blocked = [
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  it("refuses things that are not IPs", () => assert.equal(isBlockedAddress("example.com"), true));
});

describe("safeFetchText refuses dangerous targets before connecting", () => {
  const bad = [
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "http://localhost/",
    "http://foo.localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://example.com:8080/",
    "http://user:pass@example.com/",
    "http://printer.local/",
    "http://db.internal/",
    "not a url",
  ];
  for (const url of bad) {
    it(`rejects ${url}`, async () => {
      await assert.rejects(safeFetchText(url), (e: Error) => e instanceof UnsafeUrlError);
    });
  }
  it("rejects decimal/hex IP tricks that resolve to loopback", async () => {
    // WHATWG URL normalises these to 127.0.0.1, which must then be blocked
    await assert.rejects(safeFetchText("http://2130706433/"), UnsafeUrlError);
    await assert.rejects(safeFetchText("http://0x7f000001/"), UnsafeUrlError);
  });
});

describe("safeFetchText behaviour (against a local test server)", () => {
  const T = { allowPrivateNetworkForTests: true };

  it("fetches html", async () => {
    const s = await startServer((_q, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("<h1>hi</h1>")));
    try {
      const r = await safeFetchText(s.url, T);
      assert.equal(r.status, 200);
      assert.match(r.body, /hi/);
    } finally {
      await s.close();
    }
  });

  it("follows redirects and re-validates them", async () => {
    const s = await startServer((q, res) => {
      if (q.url === "/a") return void (res.writeHead(302, { location: "/b" }), res.end());
      if (q.url === "/evil") return void (res.writeHead(302, { location: "file:///etc/passwd" }), res.end());
      res.writeHead(200, { "content-type": "text/html" });
      res.end("final");
    });
    try {
      assert.equal((await safeFetchText(`${s.url}/a`, T)).body, "final");
      await assert.rejects(safeFetchText(`${s.url}/evil`, T), UnsafeUrlError);
    } finally {
      await s.close();
    }
  });

  it("caps redirects", async () => {
    const s = await startServer((_q, res) => (res.writeHead(302, { location: "/loop" }), res.end()));
    try {
      await assert.rejects(safeFetchText(`${s.url}/loop`, { ...T, maxRedirects: 3 }), /Too many redirects/);
    } finally {
      await s.close();
    }
  });

  it("caps the response size", async () => {
    const s = await startServer((_q, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("x".repeat(50_000))));
    try {
      await assert.rejects(safeFetchText(s.url, { ...T, maxBytes: 10_000 }), /larger than/);
    } finally {
      await s.close();
    }
  });

  it("times out slow servers", async () => {
    const s = await startServer(() => {
      /* never answer */
    });
    try {
      await assert.rejects(safeFetchText(s.url, { ...T, timeoutMs: 300 }), /Timed out/);
    } finally {
      await s.close();
    }
  });

  it("rejects non-text content and error statuses", async () => {
    const s = await startServer((q, res) => {
      if (q.url === "/bin") return void (res.writeHead(200, { "content-type": "application/octet-stream" }), res.end("abc"));
      json(res, 500, { no: 1 });
    });
    try {
      await assert.rejects(safeFetchText(`${s.url}/bin`, T), /Unsupported content type/);
      await assert.rejects(safeFetchText(`${s.url}/err`, T), /HTTP 500/);
    } finally {
      await s.close();
    }
  });
});
