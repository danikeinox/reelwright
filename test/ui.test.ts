import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, getPaths } from "../src/config.js";
import { addReel, getReel, newReelId, type Reel } from "../src/queue.js";
import { startUi, type UiHandle } from "../src/ui/server.js";
import { withTempHome } from "./helpers.js";

function raw(port: number, opts: { path: string; method?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      const c: Buffer[] = [];
      res.on("data", (d) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(c).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("management panel", () => {
  let home: ReturnType<typeof withTempHome>;
  let ui: UiHandle;
  let token: string;
  beforeEach(async () => {
    home = withTempHome();
    ensureDirs();
    ui = await startUi();
    token = ui.url.split("#t=")[1]!;
  });
  afterEach(async () => {
    await ui.close();
    home.cleanup();
  });

  const call = (path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) =>
    raw(ui.port, { path, method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra } });

  it("binds to loopback only and keeps the token out of the path", () => {
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{40,}$/);
  });

  it("serves the page with a strict CSP and no token needed", async () => {
    const r = await raw(ui.port, { path: "/" });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'.*script-src 'self'/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.doesNotMatch(r.body, /<script>[^<]/); // no inline scripts
  });

  it("rejects API calls without or with a wrong token", async () => {
    assert.equal((await raw(ui.port, { path: "/api/config" })).status, 401);
    assert.equal((await raw(ui.port, { path: "/api/config", headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await raw(ui.port, { path: `/api/config?t=${token}` })).status, 401); // never accepted in the query
  });

  it("rejects a foreign Host (DNS rebinding) and a foreign Origin (CSRF)", async () => {
    assert.equal((await raw(ui.port, { path: "/", headers: { host: "evil.example" } })).status, 403);
    assert.equal((await call("/api/config", "GET", undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call("/api/config", "GET", undefined, { origin: `http://127.0.0.1:${ui.port}` })).status, 200);
  });

  it("never sends secrets back and ignores empty secret fields", async () => {
    let r = await call("/api/config", "PUT", { instagram: { accessToken: "IGSECRETTOKEN123456", userId: "1784" }, storage: { mode: "s3", s3: { bucket: "b", accessKeyId: "AKIAXXXXXXXX", secretAccessKey: "S3SECRETVALUE999" } } });
    assert.equal(r.status, 200);
    for (const secret of ["IGSECRETTOKEN123456", "AKIAXXXXXXXX", "S3SECRETVALUE999"]) assert.ok(!r.body.includes(secret), secret);
    assert.equal(JSON.parse(r.body).instagram.hasToken, true);
    await call("/api/config", "PUT", { instagram: { accessToken: "", userId: "1784" } });
    const onDisk = JSON.parse(readFileSync(getPaths().config, "utf8"));
    assert.equal(onDisk.instagram.accessToken, "IGSECRETTOKEN123456");
    assert.equal(onDisk.storage.s3.secretAccessKey, "S3SECRETVALUE999");
    r = await call("/api/config");
    assert.ok(!r.body.includes("IGSECRET"));
  });

  it("rejects unknown fields and invalid values without touching the file", async () => {
    await call("/api/config", "PUT", { instagram: { userId: "123" } });
    const before = readFileSync(getPaths().config, "utf8");
    assert.equal((await call("/api/config", "PUT", { render: { browserExecutable: "/bin/sh" } })).status, 400);
    assert.equal((await call("/api/config", "PUT", { instagram: { userId: "abc" } })).status, 400);
    assert.equal((await call("/api/config", "PUT", { tts: { baseUrl: "not a url" } })).status, 400);
    assert.equal(readFileSync(getPaths().config, "utf8"), before);
  });

  it("requires JSON for writes", async () => {
    const r = await raw(ui.port, { path: "/api/config", method: "PUT", body: "x=1", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" } });
    assert.equal(r.status, 415);
  });

  describe("reviewing reels", () => {
    async function pending(): Promise<Reel> {
      writeFileSync(join(getPaths().reels, "v.mp4"), "video-bytes");
      return addReel({ id: newReelId(), createdAt: new Date().toISOString(), status: "pending_approval", hook: "H", lines: ["a"], caption: "Cap", voiceover: false, file: "v.mp4", durationSeconds: 5 });
    }

    it("approves only what the human was shown", async () => {
      const r = await pending();
      const view = JSON.parse((await call(`/api/reels/${r.id}`)).body);
      const stale = await call(`/api/reels/${r.id}/approve`, "POST", { sha256: "0".repeat(64), captionSha256: view.captionSha256 });
      assert.equal(stale.status, 500);
      assert.equal(getReel(r.id)!.status, "pending_approval");
      const ok = await call(`/api/reels/${r.id}/approve`, "POST", { sha256: view.sha256, captionSha256: view.captionSha256 });
      assert.equal(ok.status, 200);
      assert.equal(getReel(r.id)!.approval?.via, "ui");
    });

    it("editing the caption voids an earlier approval", async () => {
      const r = await pending();
      const view = JSON.parse((await call(`/api/reels/${r.id}`)).body);
      await call(`/api/reels/${r.id}/approve`, "POST", { sha256: view.sha256, captionSha256: view.captionSha256 });
      await call(`/api/reels/${r.id}/caption`, "PUT", { caption: "New caption" });
      const after = getReel(r.id)!;
      assert.equal(after.status, "pending_approval");
      assert.equal(after.approval, undefined);
    });

    it("streams the video and refuses invalid ids", async () => {
      const r = await pending();
      const v = await call(`/api/reels/${r.id}/video`);
      assert.equal(v.status, 200);
      assert.equal(v.body, "video-bytes");
      assert.equal((await call("/api/reels/..%2F..%2Fetc%2Fpasswd/video")).status, 404);
    });
  });
});
