import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, createSign } from "node:crypto";
import { ensureDirs, getPaths, loadConfig, saveConfigFile } from "../src/config.js";
import { addReel, approveReel, getReel, newReelId } from "../src/queue.js";
import { buildState, syncOnce } from "../src/remote/agent.js";
import { generateSecret, hmacHex, sha256Hex, signRequest, signResponse, verifyRequest, verifyResponse } from "../src/remote/protocol.js";
import { handle, type Env } from "../worker/src/handler.js";
import { resetAccessCache } from "../worker/src/access.js";
import { MemoryStore } from "../worker/src/store.js";
import { withTempHome, approveNow } from "./helpers.js";

const SECRET = generateSecret();
const TEAM = "acme.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64 = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function jwt(over: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = privateKey): string {
  const h = b64({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
  const p = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(NOW / 1000) + 600, email: "me@example.com", sub: "u1", ...over });
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key).toString("base64url");
  return `${h}.${p}.${sig}`;
}
const jwks = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });

const env: Env = { AGENT_SECRET: SECRET, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const ORIGIN = "https://rw.example.workers.dev";

async function dash(store: MemoryStore, path: string, init: RequestInit = {}, e: Env = env, token: string | null = jwt()) {
  const headers = new Headers(init.headers);
  if (token) headers.set("cf-access-jwt-assertion", token);
  return handle(new Request(ORIGIN + path, { ...init, headers }), e, store, { now: NOW, fetchImpl: jwks });
}
const post = (store: MemoryStore, body: unknown, extra: Record<string, string> = {}, e: Env = env) =>
  dash(store, "/api/commands", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-requested-with": "reelwright", ...extra } }, e);

async function agentSync(store: MemoryStore, state: unknown, results: unknown[] = [], secret = SECRET, now = NOW, handledAt = now) {
  const body = JSON.stringify({ state, results });
  const headers = await signRequest(secret, "POST", "/agent/sync", body, now);
  const res = await handle(new Request(ORIGIN + "/agent/sync", { method: "POST", body, headers }), env, store, { now: handledAt });
  return { res, nonce: headers["x-rw-nonce"], headers, body };
}
const goodState = (reels: unknown[] = []) => ({ version: "0.2.0", at: new Date(NOW).toISOString(), health: { summary: "ok", canRender: true, canPublish: false }, reels });
const reelRow = (id: string, status = "pending_approval") => ({ id, status, createdAt: "2026-10-12T20:00:00Z", hook: "Hook", caption: "Cap" });

describe("protocol", () => {
  it("verifies a fresh signed request and rejects tampering, staleness and wrong secrets", async () => {
    const h = await signRequest(SECRET, "POST", "/agent/sync", "{}", NOW);
    const get = (x: Record<string, string>) => ({ get: (n: string) => x[n] ?? null });
    assert.equal((await verifyRequest(SECRET, "POST", "/agent/sync", "{}", get(h), NOW)).ok, true);
    assert.equal((await verifyRequest(SECRET, "POST", "/agent/sync", "{ }", get(h), NOW)).ok, false, "body");
    assert.equal((await verifyRequest(SECRET, "POST", "/other", "{}", get(h), NOW)).ok, false, "path");
    assert.equal((await verifyRequest(SECRET, "GET", "/agent/sync", "{}", get(h), NOW)).ok, false, "method");
    assert.equal((await verifyRequest(generateSecret(), "POST", "/agent/sync", "{}", get(h), NOW)).ok, false, "secret");
    assert.equal((await verifyRequest(SECRET, "POST", "/agent/sync", "{}", get(h), NOW + 120_000)).ok, false, "stale");
    assert.equal((await verifyRequest(SECRET, "POST", "/agent/sync", "{}", get({ ...h, "x-rw-sig": "zz" }), NOW)).ok, false, "garbage sig");
  });
  it("signs responses bound to the request nonce", async () => {
    const sig = await signResponse(SECRET, "a".repeat(32), "{\"commands\":[]}");
    assert.equal(await verifyResponse(SECRET, "a".repeat(32), "{\"commands\":[]}", sig), true);
    assert.equal(await verifyResponse(SECRET, "b".repeat(32), "{\"commands\":[]}", sig), false);
    assert.equal(await verifyResponse(SECRET, "a".repeat(32), "{\"commands\":[1]}", sig), false);
  });
  it("matches a known HMAC vector (guards against accidental algorithm changes)", async () => {
    assert.equal(await hmacHex("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("remote dashboard (worker)", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
    resetAccessCache();
  });

  describe("browser side: Cloudflare Access", () => {
    it("stays locked until Access is configured", async () => {
      assert.equal((await dash(store, "/", {}, { AGENT_SECRET: SECRET })).status, 503);
    });
    it("rejects missing, forged, expired and wrong-audience tokens", async () => {
      assert.equal((await dash(store, "/", {}, env, null)).status, 401);
      assert.equal((await dash(store, "/", {}, env, "a.b.c")).status, 401);
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      assert.equal((await dash(store, "/", {}, env, jwt({}, {}, other))).status, 401, "signed by another key");
      assert.equal((await dash(store, "/", {}, env, jwt({ exp: Math.floor(NOW / 1000) - 5 }))).status, 401, "expired");
      assert.equal((await dash(store, "/", {}, env, jwt({ aud: ["someone-else"] }))).status, 401, "audience");
      assert.equal((await dash(store, "/", {}, env, jwt({ iss: "https://evil.example" }))).status, 401, "issuer");
      assert.equal((await dash(store, "/", {}, env, jwt({}, { alg: "none" }))).status, 401, "alg none");
      assert.equal((await dash(store, "/", {}, env, jwt({}, { alg: "HS256" }))).status, 401, "alg downgrade");
    });
    it("serves the app to a valid session with strict headers", async () => {
      const r = await dash(store, "/");
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-security-policy")!, /default-src 'none'/);
      assert.match(r.headers.get("strict-transport-security")!, /max-age/);
      assert.equal((await dash(store, "/app.js")).status, 200);
    });
    it("can pin the dashboard to one email", async () => {
      assert.equal((await dash(store, "/", {}, { ...env, ALLOWED_EMAIL: "me@example.com" })).status, 200);
      assert.equal((await dash(store, "/", {}, { ...env, ALLOWED_EMAIL: "other@example.com" })).status, 403);
    });
  });

  describe("agent channel", () => {
    it("refuses to run with a weak or missing secret", async () => {
      const res = await handle(new Request(ORIGIN + "/agent/sync", { method: "POST", body: "{}" }), { ...env, AGENT_SECRET: "hunter2" }, store, { now: NOW });
      assert.equal(res.status, 503);
    });
    it("accepts a signed sync, stores state and signs its answer", async () => {
      const { res, nonce } = await agentSync(store, goodState());
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(await verifyResponse(SECRET, nonce, text, res.headers.get("x-rw-sig")!), true);
      assert.deepEqual(JSON.parse(text), { commands: [] });
      assert.ok(store.state);
    });
    it("answers every authentication failure identically and refuses replays", async () => {
      const bad = await agentSync(store, goodState(), [], generateSecret());
      assert.equal(bad.res.status, 401);
      const ok = await agentSync(store, goodState());
      assert.equal(ok.res.status, 200);
      const replay = await handle(new Request(ORIGIN + "/agent/sync", { method: "POST", body: ok.body, headers: ok.headers }), env, store, { now: NOW });
      assert.equal(replay.status, 401);
      const stale = await agentSync(store, goodState(), [], SECRET, NOW - 5 * 60_000, NOW);
      assert.equal(stale.res.status, 401);
      assert.equal(await bad.res.text(), await replay.text());
    });
    it("rejects payloads with unexpected fields (no smuggling paths or secrets through the state)", async () => {
      const dirty = { ...goodState(), reels: [{ ...reelRow("r_aaaaaaaaaa"), file: "/home/me/.reelwright/reels/x.mp4" }] };
      assert.equal((await agentSync(store, dirty)).res.status, 400);
      assert.equal((await agentSync(store, { ...goodState(), token: "x" })).res.status, 400);
    });
    it("caps request size", async () => {
      const big = "x".repeat(300 * 1024);
      const headers = await signRequest(SECRET, "POST", "/agent/sync", big, NOW);
      const res = await handle(new Request(ORIGIN + "/agent/sync", { method: "POST", body: big, headers }), env, store, { now: NOW });
      assert.equal(res.status, 413);
    });
    it("does not expose the agent route to GET", async () => {
      assert.equal((await handle(new Request(ORIGIN + "/agent/sync"), env, store, { now: NOW })).status, 404);
    });
  });

  describe("commands from the browser", () => {
    const id = "r_aaaaaaaaaa";
    beforeEach(async () => {
      await agentSync(store, goodState([reelRow(id), reelRow("r_bbbbbbbbbb", "published"), reelRow("r_cccccccccc", "rendering")]));
    });

    it("blocks cross-site requests (CSRF)", async () => {
      const body = JSON.stringify({ type: "reject_reel", reelId: id });
      const h = { "content-type": "application/json" };
      assert.equal((await dash(store, "/api/commands", { method: "POST", body, headers: h })).status, 403, "no custom header");
      assert.equal((await post(store, { type: "reject_reel", reelId: id }, { origin: "https://evil.example" })).status, 403, "foreign origin");
      assert.equal((await post(store, { type: "reject_reel", reelId: id }, { "sec-fetch-site": "cross-site" })).status, 403, "cross-site");
      assert.equal((await dash(store, "/api/commands", { method: "POST", body, headers: { "x-requested-with": "reelwright", "content-type": "text/plain" } })).status, 415);
    });

    it("can never ask for approval, publishing or secret-bearing settings", async () => {
      for (const evil of [
        { type: "approve_reel", reelId: id },
        { type: "publish_reel", reelId: id },
        { type: "set_config", instagram: { accessToken: "x".repeat(20) } },
        { type: "set_caption", reelId: id, caption: "ok", approved: true },
        { type: "set_theme", bg: "#000000", fg: "#ffffff", accent: "#ff0000", baseUrl: "https://evil" },
        { type: "reject_reel", reelId: "../../etc/passwd" },
      ]) assert.equal((await post(store, evil)).status, 400, JSON.stringify(evil));
      assert.equal(store.commands.size, 0);
    });

    it("validates the target reel and its state", async () => {
      assert.equal((await post(store, { type: "reject_reel", reelId: "r_dddddddddd" })).status, 404);
      assert.equal((await post(store, { type: "reject_reel", reelId: "r_bbbbbbbbbb" })).status, 409, "already published");
      assert.equal((await post(store, { type: "set_caption", reelId: "r_cccccccccc", caption: "x" })).status, 409, "still rendering");
    });

    it("queues once, delivers once, records the result", async () => {
      const q = await post(store, { type: "set_caption", reelId: id, caption: "New text" });
      assert.equal(q.status, 202);
      const first = await agentSync(store, goodState([reelRow(id)]));
      const cmds = JSON.parse(await first.res.text()).commands;
      assert.equal(cmds.length, 1);
      assert.equal(cmds[0].caption, "New text");
      const second = await agentSync(store, goodState([reelRow(id)]), [{ id: cmds[0].id, ok: true }]);
      assert.deepEqual(JSON.parse(await second.res.text()), { commands: [] });
      const log = JSON.parse(await (await dash(store, "/api/state")).text());
      assert.equal(log.commands[0].status, "done");
    });

    it("caps the pending queue and expires old commands", async () => {
      for (let i = 0; i < 25; i++) assert.equal((await post(store, { type: "reject_reel", reelId: id })).status, 202);
      assert.equal((await post(store, { type: "reject_reel", reelId: id })).status, 429);
      const later = await agentSync(store, goodState([reelRow(id)]), [], SECRET, NOW + 25 * 3600_000);
      assert.deepEqual(JSON.parse(await later.res.text()), { commands: [] });
    });
  });
});

describe("local agent <-> dashboard, end to end", () => {
  let home: ReturnType<typeof withTempHome>;
  let store: MemoryStore;
  const viaWorker = (tamper?: (r: Response) => Promise<Response>): typeof fetch =>
    (async (input: any, init: any) => {
      const res = await handle(new Request(String(input), init), env, store, { now: Date.now(), fetchImpl: jwks });
      return tamper ? tamper(res) : res;
    }) as typeof fetch;
  async function reel(status: "pending_approval" = "pending_approval") {
    writeFileSync(join(getPaths().reels, "v.mp4"), "bytes");
    return addReel({ id: newReelId(), createdAt: new Date().toISOString(), status, hook: "Hook", lines: ["a"], caption: "Original", voiceover: false, file: "v.mp4", durationSeconds: 5 });
  }
  const cfg = () => {
    saveConfigFile({ ...JSON.parse(readFileSync(getPaths().config, "utf8")), remote: { url: ORIGIN, secret: SECRET } });
    return loadConfig();
  };
  async function queue(body: unknown) {
    // the dashboard session is valid "now" in real time here, so mint the token against the real clock
    const t = jwt({ exp: Math.floor(Date.now() / 1000) + 600 });
    return handle(new Request(ORIGIN + "/api/commands", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-requested-with": "reelwright", "cf-access-jwt-assertion": t } }), env, store, { now: Date.now(), fetchImpl: jwks });
  }

  beforeEach(() => {
    home = withTempHome();
    ensureDirs();
    writeFileSync(getPaths().config, "{}");
    store = new MemoryStore();
    resetAccessCache();
  });
  afterEach(() => home.cleanup());

  it("reports state without paths or secrets", async () => {
    saveConfigFile({ instagram: { accessToken: "IGSECRETTOKEN123456", userId: "1", apiVersion: "v25.0", apiHost: "https://graph.instagram.com" }, remote: { url: ORIGIN, secret: SECRET } });
    await reel();
    const text = JSON.stringify(await buildState());
    for (const leak of ["IGSECRETTOKEN123456", SECRET, "v.mp4", getPaths().home]) assert.ok(!text.includes(leak), leak);
  });

  it("applies a caption edit from the dashboard and voids the approval", async () => {
    const r = await reel();
    await approveNow(r.id);
    assert.equal(getReel(r.id)!.status, "approved");
    await syncOnce(cfg(), viaWorker()); // publishes state so the dashboard knows the reel
    assert.equal((await queue({ type: "set_caption", reelId: r.id, caption: "Edited remotely" })).status, 202);
    const out = await syncOnce(cfg(), viaWorker());
    assert.equal(out.executed, 1);
    const after = getReel(r.id)!;
    assert.equal(after.caption, "Edited remotely");
    assert.equal(after.status, "pending_approval");
    assert.equal(after.approval, undefined);
    await syncOnce(cfg(), viaWorker()); // reports the result
    assert.equal([...store.commands.values()][0]!.status, "done");
  });

  it("rejects a reel and changes the theme", async () => {
    const r = await reel();
    await syncOnce(cfg(), viaWorker());
    await queue({ type: "reject_reel", reelId: r.id });
    await queue({ type: "set_theme", bg: "#101010", fg: "#ffffff", accent: "#00aa55" });
    await syncOnce(cfg(), viaWorker());
    assert.equal(getReel(r.id)!.status, "rejected");
    assert.deepEqual(JSON.parse(readFileSync(getPaths().config, "utf8")).defaultTheme, { bg: "#101010", fg: "#ffffff", accent: "#00aa55" });
  });

  it("ignores an answer that is not signed with the shared secret", async () => {
    const r = await reel();
    await syncOnce(cfg(), viaWorker());
    await queue({ type: "reject_reel", reelId: r.id });
    const forged = viaWorker(async () => new Response(JSON.stringify({ commands: [{ id: "a".repeat(32), type: "reject_reel", reelId: r.id }] }), { status: 200, headers: { "x-rw-sig": "0".repeat(64) } }));
    await assert.rejects(syncOnce(cfg(), forged), /not signed/);
    assert.equal(getReel(r.id)!.status, "pending_approval");
  });

  it("never runs the same command twice", async () => {
    const r = await reel();
    await syncOnce(cfg(), viaWorker());
    await queue({ type: "set_caption", reelId: r.id, caption: "Once" });
    let delivered: string | undefined;
    const spy = viaWorker(async (res) => ((delivered ??= await res.clone().text()), res));
    await syncOnce(cfg(), spy);
    assert.equal(getReel(r.id)!.caption, "Once");
    const replayBody = delivered!;
    // a hostile or buggy dashboard redelivers the same command with a valid signature
    const redeliver = (async (input: any, init: any) => {
      const nonce = new Headers(init.headers).get("x-rw-nonce")!;
      return new Response(replayBody, { status: 200, headers: { "x-rw-sig": await signResponse(SECRET, nonce, replayBody) } });
    }) as typeof fetch;
    await (await import("../src/queue.js")).setReelCaption(r.id, "Changed locally");
    await syncOnce(cfg(), redeliver);
    assert.equal(getReel(r.id)!.caption, "Changed locally");
  });

  it("refuses non-https dashboards and weak secrets in config", () => {
    assert.throws(() => saveConfigFile({ remote: { url: "http://example.com", secret: SECRET } }), /https/);
    assert.throws(() => saveConfigFile({ remote: { url: ORIGIN, secret: "short" } }), /64 hex/);
  });
});
