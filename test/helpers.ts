import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Gives the test its own empty Reelwright home and cleans it up afterwards. */
export function withTempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reelwright-test-"));
  const prev = process.env.REELWRIGHT_HOME;
  process.env.REELWRIGHT_HOME = dir;
  for (const k of ["REELWRIGHT_IG_TOKEN", "REELWRIGHT_IG_USER_ID", "REELWRIGHT_S3_BUCKET", "REELWRIGHT_BROWSER"]) delete process.env[k];
  return {
    dir,
    cleanup: () => {
      if (prev === undefined) delete process.env.REELWRIGHT_HOME;
      else process.env.REELWRIGHT_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestServer {
  url: string;
  port: number;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}

export async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}

export function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** A tiny valid PCM WAV (sine tone) of the given length. */
export function makeWav(seconds: number, sampleRate = 24000): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 6000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Minimal stand-in for Instagram's Graph API (Instagram Login). */
export async function startMockGraph(opts: { processingPolls?: number; failContainer?: boolean } = {}) {
  let polls = 0;
  const server = await startServer((req, res, body) => {
    const u = new URL(req.url ?? "/", "http://x");
    const form = new URLSearchParams(body);
    const token = u.searchParams.get("access_token") ?? form.get("access_token") ?? "";
    if (token.startsWith("BADTOKEN")) {
      return json(res, 400, { error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" } });
    }
    const p = u.pathname;
    if (p === "/refresh_access_token") return json(res, 200, { access_token: "REFRESHEDTOKEN1234567890", token_type: "bearer", expires_in: 5184000 });
    if (p.endsWith("/me")) return json(res, 200, { user_id: "17841400000000000", username: "reelwright_test", account_type: "BUSINESS" });
    if (req.method === "POST" && p.endsWith("/media")) return json(res, 200, { id: "container-1" });
    if (p.endsWith("/container-1")) {
      polls++;
      if (opts.failContainer) return json(res, 200, { status_code: "ERROR", status: "Error: 2207026 unsupported video" });
      return json(res, 200, { status_code: polls > (opts.processingPolls ?? 1) ? "FINISHED" : "IN_PROGRESS" });
    }
    if (req.method === "POST" && p.endsWith("/media_publish")) return json(res, 200, { id: "999000111" });
    if (p.endsWith("/999000111/comments")) return json(res, 200, { data: [{ id: "555", text: "Love it!", username: "fan", timestamp: "2026-10-12T10:00:00+0000" }] });
    if (p.endsWith("/999000111")) return json(res, 200, { permalink: "https://www.instagram.com/reel/TEST/" });
    if (req.method === "POST" && p.endsWith("/replies")) return json(res, 200, { id: "666" });
    json(res, 404, { error: { message: `no route ${p}`, code: 100 } });
  });
  return server;
}

/** Path-style fake S3: stores PUT bodies, serves GET, honours DELETE (signatures are not verified). */
export async function startFakeS3() {
  const store = new Map<string, Buffer>();
  const server = await startServer((req, res, _body) => {
    void _body;
  });
  await server.close();
  const events: string[] = [];
  const s3 = http.createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").split("?")[0]!);
    events.push(`${req.method} ${key}`);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        store.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"x"' }).end();
      });
    } else if (req.method === "GET") {
      const b = store.get(key);
      b ? res.writeHead(200, { "content-type": "video/mp4" }).end(b) : res.writeHead(404).end();
    } else if (req.method === "DELETE") {
      store.delete(key);
      res.writeHead(204).end();
    } else res.writeHead(405).end();
  });
  await new Promise<void>((r) => s3.listen(0, "127.0.0.1", r));
  const port = (s3.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    events,
    close: () => new Promise<void>((r) => (s3.closeAllConnections(), s3.close(() => r()))),
  };
}

/** Approves like a human who just reviewed the reel as it currently is. */
export async function approveNow(id: string, via: "cli" | "elicitation" | "ui" = "cli") {
  const { approveReel, getReel, reviewSnapshot } = await import("../src/queue.js");
  const reel = getReel(id)!;
  let seen = { sha256: "0".repeat(64), captionSha256: "0".repeat(64) };
  try {
    seen = await reviewSnapshot(reel);
  } catch {
    /* no video yet: the pre-checks in approveReel reject before the hashes matter */
  }
  return approveReel(id, via, seen);
}
