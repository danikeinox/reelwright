import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveSingleFile } from "../src/storage/file-server.js";
import { stageViaS3 } from "../src/storage/s3.js";
import { parseTunnelUrl, stageViaTunnel } from "../src/storage/tunnel.js";

describe("single-file server", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rw-file-"));
    file = join(dir, "v.mp4");
    writeFileSync(file, Buffer.from("0123456789".repeat(100)));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves only the secret path, with HEAD and Range support", async () => {
    const s = await serveSingleFile(file);
    try {
      const base = `http://127.0.0.1:${s.port}`;
      assert.equal((await fetch(`${base}/`)).status, 404);
      assert.equal((await fetch(`${base}/guess.mp4`)).status, 404);
      assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404);
      const head = await fetch(`${base}${s.path}`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-length"), "1000");
      assert.equal(head.headers.get("content-type"), "video/mp4");
      const full = await fetch(`${base}${s.path}`);
      assert.equal((await full.arrayBuffer()).byteLength, 1000);
      const part = await fetch(`${base}${s.path}`, { headers: { range: "bytes=10-19" } });
      assert.equal(part.status, 206);
      assert.equal(await part.text(), "0123456789");
      assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
      const tail = await fetch(`${base}${s.path}`, { headers: { range: "bytes=-5" } });
      assert.equal(tail.status, 206);
      assert.equal((await tail.text()).length, 5);
      assert.equal((await fetch(`${base}${s.path}`, { headers: { range: "bytes=5000-" } })).status, 416);
      assert.equal((await fetch(`${base}${s.path}`, { method: "POST" })).status, 404);
    } finally {
      await s.close();
    }
  });

  it("listens on loopback only and uses an unguessable path", async () => {
    const a = await serveSingleFile(file);
    const b = await serveSingleFile(file);
    try {
      assert.notEqual(a.path, b.path);
      assert.ok(a.path.length > 20);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("tunnel", () => {
  it("parses the quick-tunnel URL out of cloudflared logs", () => {
    assert.equal(
      parseTunnelUrl("2026-10-12 INF |  https://quiet-forest-demo-1234.trycloudflare.com  |"),
      "https://quiet-forest-demo-1234.trycloudflare.com",
    );
    assert.equal(parseTunnelUrl("https://evil.example/trycloudflare.com"), null);
  });

  it("starts the binary, builds the public URL and cleans up", async (t) => {
    if (process.platform === "win32") return t.skip("shell script stub");
    const dir = mkdtempSync(join(tmpdir(), "rw-tunnel-"));
    const video = join(dir, "v.mp4");
    writeFileSync(video, "video");
    const stub = join(dir, "fake-cloudflared");
    writeFileSync(stub, `#!/bin/sh\necho "INF Requesting new quick Tunnel" >&2\necho "INF |  https://fake-demo-test-123.trycloudflare.com  |" >&2\nsleep 60\n`);
    chmodSync(stub, 0o755);
    try {
      const staged = await stageViaTunnel(video, { binary: stub, skipReadinessCheck: true });
      assert.match(staged.url, /^https:\/\/fake-demo-test-123\.trycloudflare\.com\/[A-Za-z0-9_-]{20,}\.mp4$/);
      await staged.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the binary dies, and when it never prints a URL", async (t) => {
    if (process.platform === "win32") return t.skip("shell script stub");
    const dir = mkdtempSync(join(tmpdir(), "rw-tunnel-"));
    const video = join(dir, "v.mp4");
    writeFileSync(video, "video");
    const dies = join(dir, "dies");
    writeFileSync(dies, "#!/bin/sh\nexit 3\n");
    const silent = join(dir, "silent");
    writeFileSync(silent, "#!/bin/sh\nsleep 60\n");
    chmodSync(dies, 0o755);
    chmodSync(silent, 0o755);
    try {
      await assert.rejects(stageViaTunnel(video, { binary: dies }), /exited early/);
      await assert.rejects(stageViaTunnel(video, { binary: silent, startTimeoutMs: 300 }), /Timed out/);
      await assert.rejects(stageViaTunnel(video, { binary: join(dir, "missing") }), /Could not start cloudflared|ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("S3 / R2 adapter (fake S3 server)", () => {
  it("uploads, hands out a signed URL that serves the object, and deletes it afterwards", async () => {
    const store = new Map<string, Buffer>();
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? "").split("?")[0]!);
      seen.push(`${req.method} ${key}`);
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200, { etag: '"abc"' }).end();
        });
      } else if (req.method === "GET") {
        const body = store.get(key);
        if (!body) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "video/mp4" }).end(body);
      } else if (req.method === "DELETE") {
        store.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "rw-s3-"));
    const video = join(dir, "v.mp4");
    writeFileSync(video, "the-video-bytes");
    try {
      const staged = await stageViaS3(
        { endpoint: `http://127.0.0.1:${port}`, region: "auto", bucket: "my-bucket", accessKeyId: "AKIATEST", secretAccessKey: "secret", prefix: "reelwright/", forcePathStyle: true, signedUrlTtlSeconds: 600 },
        video,
        "r_1234567890",
      );
      assert.match(staged.url, /^http:\/\/127\.0\.0\.1:\d+\/my-bucket\/reelwright\/r_1234567890-[0-9a-f]{12}\.mp4\?/);
      assert.match(staged.url, /X-Amz-Signature=/);
      assert.match(staged.url, /X-Amz-Expires=600/);
      const res = await fetch(staged.url);
      assert.equal(await res.text(), "the-video-bytes");
      await staged.cleanup();
      assert.equal(store.size, 0, "object must be deleted after publishing");
      assert.ok(seen.some((s) => s.startsWith("DELETE ")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      server.closeAllConnections();
      server.close();
    }
  });
});

void readFileSync;
