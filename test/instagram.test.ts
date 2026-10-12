import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema, ensureDirs, getPaths, loadConfig, readConfigFile, saveConfigFile } from "../src/config.js";
import { InstagramClient } from "../src/instagram.js";
import { publishApprovedReel } from "../src/publish.js";
import { addReel, approveReel, getReel, newReelId } from "../src/queue.js";
import { maybeRefreshToken } from "../src/token.js";
import { startMockGraph, withTempHome, type TestServer, approveNow } from "./helpers.js";

function cfgFor(server: TestServer, token = "GOODTOKEN1234567890") {
  return ConfigSchema.parse({ instagram: { accessToken: token, userId: "17841400000000000", apiHost: server.url } });
}

describe("InstagramClient (mock Graph API)", () => {
  it("identifies the account", async () => {
    const g = await startMockGraph();
    try {
      const me = await new InstagramClient(cfgFor(g)).me();
      assert.equal(me.username, "reelwright_test");
      assert.match(g.requests[0]!.url, /\/v25\.0\/me\?/);
    } finally {
      await g.close();
    }
  });

  it("creates a REELS container, polls until FINISHED, publishes and returns the permalink", async () => {
    const g = await startMockGraph({ processingPolls: 2 });
    try {
      const ig = new InstagramClient(cfgFor(g));
      const container = await ig.createReelContainer("https://cdn.example/video.mp4", "Hello #world");
      assert.equal(container, "container-1");
      const create = g.requests.find((r) => r.method === "POST" && r.url.endsWith("/media"))!;
      const form = new URLSearchParams(create.body);
      assert.equal(form.get("media_type"), "REELS");
      assert.equal(form.get("video_url"), "https://cdn.example/video.mp4");
      assert.equal(form.get("caption"), "Hello #world");
      assert.equal(create.url.includes("access_token"), false, "token must travel in the body, not the URL");

      await ig.waitUntilReady(container, { intervalMs: 5 });
      const polls = g.requests.filter((r) => r.url.includes("/container-1")).length;
      assert.equal(polls, 3);

      const out = await ig.publish(container);
      assert.deepEqual(out, { mediaId: "999000111", permalink: "https://www.instagram.com/reel/TEST/" });
    } finally {
      await g.close();
    }
  });

  it("surfaces processing errors", async () => {
    const g = await startMockGraph({ failContainer: true });
    try {
      await assert.rejects(new InstagramClient(cfgFor(g)).waitUntilReady("container-1", { intervalMs: 5 }), /could not process the video \(ERROR/);
    } finally {
      await g.close();
    }
  });

  it("times out when processing never finishes", async () => {
    const g = await startMockGraph({ processingPolls: 9999 });
    try {
      await assert.rejects(new InstagramClient(cfgFor(g)).waitUntilReady("container-1", { intervalMs: 5, maxWaitMs: 60 }), /still processing/);
    } finally {
      await g.close();
    }
  });

  it("maps API errors to actionable messages and never leaks the token", async () => {
    const g = await startMockGraph();
    try {
      const bad = cfgFor(g, "BADTOKEN-super-secret-value");
      await assert.rejects(new InstagramClient(bad).me(), (e: Error) => /expired|invalid/i.test(e.message) && !e.message.includes("super-secret"));
    } finally {
      await g.close();
    }
  });

  it("reads comments and replies", async () => {
    const g = await startMockGraph();
    try {
      const ig = new InstagramClient(cfgFor(g));
      const comments = await ig.listComments("999000111");
      assert.equal(comments[0]!.username, "fan");
      assert.equal(await ig.replyToComment("555", "Thanks!"), "666");
    } finally {
      await g.close();
    }
  });

  it("refuses to start without a token", () => {
    assert.throws(() => new InstagramClient(ConfigSchema.parse({})), /not connected/);
  });

  it("refuses a plain-http API host that is not local (token exfiltration guard)", () => {
    assert.throws(() => ConfigSchema.parse({ instagram: { apiHost: "http://evil.example" } }), /https/);
    assert.doesNotThrow(() => ConfigSchema.parse({ instagram: { apiHost: "https://graph.instagram.com" } }));
  });
});

describe("publish flow & token refresh", () => {
  let home: ReturnType<typeof withTempHome>;
  let g: TestServer;
  beforeEach(async () => {
    home = withTempHome();
    ensureDirs();
    g = await startMockGraph();
    saveConfigFile({ instagram: { accessToken: "OLDTOKEN1234567890", userId: "17841400000000000", apiHost: g.url, tokenRefreshedAt: new Date().toISOString() } });
  });
  afterEach(async () => {
    await g.close();
    home.cleanup();
  });

  async function pendingReel() {
    mkdirSync(getPaths().reels, { recursive: true });
    writeFileSync(join(getPaths().reels, "v.mp4"), "fake-video");
    return addReel({ id: newReelId(), createdAt: new Date().toISOString(), status: "pending_approval", hook: "h", lines: ["l"], caption: "My caption", voiceover: false, file: "v.mp4" });
  }

  const fakeStage = (log: string[]) => async (_cfg: unknown, _file: string, id: string) => {
    log.push(`stage:${id}`);
    return { url: "https://tunnel.example/abc.mp4", cleanup: async () => void log.push("cleanup") };
  };

  it("refuses to publish an unapproved reel and touches nothing", async () => {
    const r = await pendingReel();
    const log: string[] = [];
    await assert.rejects(publishApprovedReel(r.id, { stage: fakeStage(log), skipTokenRefresh: true }), /not approved/);
    assert.deepEqual(log, []);
    assert.equal(g.requests.length, 0);
  });

  it("publishes an approved reel end to end and cleans up the temporary URL", async () => {
    const r = await pendingReel();
    await approveNow(r.id);
    const log: string[] = [];
    const done = await publishApprovedReel(r.id, { stage: fakeStage(log), pollIntervalMs: 5, skipTokenRefresh: true });
    assert.equal(done.status, "published");
    assert.equal(done.publish?.mediaId, "999000111");
    assert.equal(done.publish?.permalink, "https://www.instagram.com/reel/TEST/");
    assert.deepEqual(log, [`stage:${r.id}`, "cleanup"]);
    const create = g.requests.find((q) => q.url.endsWith("/media") && q.method === "POST")!;
    assert.equal(new URLSearchParams(create.body).get("caption"), "My caption");
    // cannot be published twice
    await assert.rejects(publishApprovedReel(r.id, { stage: fakeStage(log), skipTokenRefresh: true }), /not approved/);
  });

  it("blocks publishing if the video was swapped after approval", async () => {
    const r = await pendingReel();
    await approveNow(r.id);
    writeFileSync(join(getPaths().reels, "v.mp4"), "different-bytes");
    await assert.rejects(publishApprovedReel(r.id, { stage: fakeStage([]), skipTokenRefresh: true }), /changed after approval/);
    assert.equal(g.requests.length, 0);
  });

  it("returns to 'approved' (retryable) and still cleans up when Instagram fails", async () => {
    await g.close();
    g = await startMockGraph({ failContainer: true });
    saveConfigFile({ instagram: { accessToken: "OLDTOKEN1234567890", userId: "17841400000000000", apiHost: g.url, tokenRefreshedAt: new Date().toISOString() } });
    const r = await pendingReel();
    await approveNow(r.id);
    const log: string[] = [];
    await assert.rejects(publishApprovedReel(r.id, { stage: fakeStage(log), pollIntervalMs: 5, skipTokenRefresh: true }), /could not process/);
    const after = getReel(r.id)!;
    assert.equal(after.status, "approved");
    assert.match(after.error ?? "", /could not process/);
    assert.ok(log.includes("cleanup"));
  });

  it("refreshes the token when it is older than 20 days and saves the new one with 0600", async () => {
    saveConfigFile({ instagram: { accessToken: "OLDTOKEN1234567890", userId: "17841400000000000", apiHost: g.url, tokenRefreshedAt: new Date(Date.now() - 25 * 86400e3).toISOString() } });
    assert.equal(await maybeRefreshToken(), true);
    const saved = readConfigFile();
    assert.equal(saved.instagram.accessToken, "REFRESHEDTOKEN1234567890");
    assert.ok(Date.now() - Date.parse(saved.instagram.tokenRefreshedAt) < 5000);
    assert.equal(loadConfig().instagram.userId, "17841400000000000", "other settings are preserved");
  });

  it("does not refresh a recent token, nor one managed through the environment", async () => {
    assert.equal(await maybeRefreshToken(), false);
    saveConfigFile({ instagram: { accessToken: "OLDTOKEN1234567890", userId: "1", apiHost: g.url, tokenRefreshedAt: new Date(Date.now() - 40 * 86400e3).toISOString() } });
    process.env.REELWRIGHT_IG_TOKEN = "ENVTOKEN1234567890";
    try {
      assert.equal(await maybeRefreshToken(), false);
    } finally {
      delete process.env.REELWRIGHT_IG_TOKEN;
    }
  });

  it("a failed refresh is not fatal and keeps the old token", async () => {
    await g.close();
    g = await startMockGraph();
    saveConfigFile({ instagram: { accessToken: "BADTOKEN1234567890", userId: "1", apiHost: g.url, tokenRefreshedAt: new Date(Date.now() - 40 * 86400e3).toISOString() } });
    const msgs: string[] = [];
    assert.equal(await maybeRefreshToken((m) => msgs.push(m)), false);
    assert.equal(readConfigFile().instagram.accessToken, "BADTOKEN1234567890");
    assert.match(msgs.join(" "), /not refreshed/);
  });
});
