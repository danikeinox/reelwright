import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, createSign } from "node:crypto";
import { ensureDirs, getPaths, loadConfig, saveConfigFile } from "../src/config.js";
import { addReel, approveReel, getReel, newReelId, reviewSnapshot, setReelCaption, updateReel, type Reel } from "../src/queue.js";
import { scrubError, syncOnce } from "../src/remote/agent.js";
import { CommandSchema, isSafeCaption, generateSecret } from "../src/remote/protocol.js";
import { startUi, type UiHandle } from "../src/ui/server.js";
import { verifyAccessJwt, resetAccessCache } from "../worker/src/access.js";
import { withTempHome } from "./helpers.js";

function sample(over: Partial<Reel> = {}): Reel {
  return { id: newReelId(), createdAt: new Date().toISOString(), status: "pending_approval", hook: "H", lines: ["a"], caption: "Cap", voiceover: false, file: "v.mp4", ...over };
}

describe("approval is bound to what the human reviewed", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => {
    home = withTempHome();
    ensureDirs();
    writeFileSync(join(getPaths().reels, "v.mp4"), "video-bytes");
  });
  afterEach(() => home.cleanup());

  it("refuses to approve a caption that changed after the review screen was shown", async () => {
    const r = await addReel(sample());
    const seen = await reviewSnapshot(getReel(r.id)!);
    await setReelCaption(r.id, "Something the human never saw"); // e.g. a remote edit while the prompt was open
    await assert.rejects(approveReel(r.id, "elicitation", seen), /changed since you looked/);
    assert.equal(getReel(r.id)!.status, "pending_approval");
  });

  it("refuses to approve a different video than the one reviewed", async () => {
    const r = await addReel(sample());
    const seen = await reviewSnapshot(getReel(r.id)!);
    writeFileSync(join(getPaths().reels, "v.mp4"), "other-bytes");
    await assert.rejects(approveReel(r.id, "cli", seen), /changed since you looked/);
  });

  it("never turns a reel that is being published or was rejected back into approved", async () => {
    for (const status of ["publishing", "rejected", "published"] as const) {
      const r = await addReel(sample({ status }));
      const seen = await reviewSnapshot(getReel(r.id)!);
      await assert.rejects(approveReel(r.id, "cli", seen), /only rendered reels/);
      assert.equal(getReel(r.id)!.status, status);
    }
  });

  it("does not overwrite a rejection that lands between review and approval", async () => {
    const r = await addReel(sample());
    const seen = await reviewSnapshot(getReel(r.id)!);
    await updateReel(r.id, { status: "rejected" });
    await assert.rejects(approveReel(r.id, "cli", seen));
    assert.equal(getReel(r.id)!.status, "rejected");
  });
});

describe("captions cannot hide content from a reviewer", () => {
  it("flags control, zero-width and bidi characters and walls of blank lines", () => {
    assert.equal(isSafeCaption("Hello world\n\nSecond paragraph #tag"), true);
    assert.equal(isSafeCaption("héllo ñ 🎬 日本語"), true);
    assert.equal(isSafeCaption("hi\u200bthere"), false, "zero width");
    assert.equal(isSafeCaption("hi \u202eevil"), false, "bidi override");
    assert.equal(isSafeCaption("hi\u0007"), false, "bell");
    assert.equal(isSafeCaption("hi" + "\n".repeat(40) + "http://evil"), false, "blank-line wall");
    assert.equal(isSafeCaption("   "), false);
  });
  it("is enforced for remote caption commands", () => {
    const ok = { id: "a".repeat(32), type: "set_caption", reelId: "r_aaaaaaaaaa", caption: "fine" };
    assert.ok(CommandSchema.safeParse(ok).success);
    assert.ok(!CommandSchema.safeParse({ ...ok, caption: "x" + "\n".repeat(30) + "y" }).success);
  });
});

describe("panel hardening from the review", () => {
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
  const get = (path: string) =>
    new Promise<{ status: number; location?: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: ui.port, path, headers: { host: `127.0.0.1:${ui.port}` } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      }).on("error", reject);
    });
  const put = (body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: ui.port, path: "/api/config", method: "PUT", headers: { host: `127.0.0.1:${ui.port}`, authorization: `Bearer ${token}`, "content-type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  it("hands the OS a single-use link that never contains the real token", async () => {
    const link = ui.openUrl();
    assert.ok(!link.includes(token));
    assert.ok(!link.includes("#"));
    const path = new URL(link).pathname;
    const first = await get(path);
    assert.equal(first.status, 302);
    assert.equal(first.location, `/#t=${token}`);
    assert.equal((await get(path)).status, 404, "second use");
    assert.equal((await get("/o/" + "A".repeat(32))).status, 404, "guessed");
  });

  it("drops the stored voice key when the voice server address changes, and refuses plain http to other hosts", async () => {
    assert.equal(await put({ tts: { enabled: true, baseUrl: "http://127.0.0.1:9/v1", apiKey: "VOICEKEY12345678" } }), 200);
    assert.equal(JSON.parse(readFileSync(getPaths().config, "utf8")).tts.apiKey, "VOICEKEY12345678");
    assert.equal(await put({ tts: { baseUrl: "https://voice.example.com/v1" } }), 200);
    assert.equal(JSON.parse(readFileSync(getPaths().config, "utf8")).tts.apiKey, undefined, "key must not follow a new address");
    assert.equal(await put({ tts: { baseUrl: "http://evil.example.com/v1" } }), 400);
  });

  it("requires the keys again when the bucket endpoint changes", async () => {
    assert.equal(await put({ storage: { mode: "s3", s3: { endpoint: "https://a.example.com", bucket: "b", accessKeyId: "AKIAAAAAAAA", secretAccessKey: "SECRETSECRET1" } } }), 200);
    assert.equal(await put({ storage: { s3: { endpoint: "https://b.example.com" } } }), 400);
    assert.equal(JSON.parse(readFileSync(getPaths().config, "utf8")).storage.s3.endpoint, "https://a.example.com");
    assert.equal(await put({ storage: { s3: { endpoint: "http://b.example.com", accessKeyId: "AKIAAAAAAAA", secretAccessKey: "SECRETSECRET1" } } }), 400, "plain http");
  });
});

describe("agent and worker hardening from the review", () => {
  it("scrubs paths and URLs from errors that leave the computer", () => {
    const out = scrubError("ENOENT: open '/home/daniel/.reelwright/reels/r_x.mp4' via https://bucket.r2.example/x?X-Amz-Signature=abc and C:\\Users\\Dani\\a.mp4");
    assert.ok(!/daniel|Signature|Users|bucket/i.test(out), out);
  });

  it("refuses an oversized answer from the dashboard before reading it all", async () => {
    const home = withTempHome();
    try {
      ensureDirs();
      writeFileSync(getPaths().config, "{}");
      const secret = generateSecret();
      saveConfigFile({ remote: { url: "https://dash.example.com", secret } });
      const huge = (async () => new Response("x".repeat(400 * 1024), { status: 200 })) as unknown as typeof fetch;
      await assert.rejects(syncOnce(loadConfig(), huge), /too large/);
    } finally {
      home.cleanup();
    }
  });

  it("does not let forged tokens trigger repeated key downloads", async () => {
    resetAccessCache();
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "known", alg: "RS256" };
    let fetches = 0;
    const fetchImpl = async () => ((fetches++, { ok: true, json: async () => ({ keys: [jwk] }) }));
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = (kid: string) => {
      const h = b64({ alg: "RS256", kid });
      const p = b64({ aud: ["a"], iss: "https://t.cloudflareaccess.com", exp: 9_999_999_999 });
      return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url")}`;
    };
    const cfg = { teamDomain: "t.cloudflareaccess.com", aud: "a" };
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 20; i++) assert.equal(await verifyAccessJwt(forged(`unknown-${i}`), cfg, fetchImpl, t0 + i * 100), null);
    assert.ok(fetches <= 1, `expected at most 1 download inside a minute, got ${fetches}`);
    for (let i = 0; i < 20; i++) assert.equal(await verifyAccessJwt(forged("known"), cfg, fetchImpl, t0 + 120_000 + i), null);
    assert.ok(fetches <= 2, `a known kid with a bad signature must not trigger downloads, got ${fetches}`);
  });
});
