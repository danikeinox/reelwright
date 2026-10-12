import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, getPaths } from "../src/config.js";
import {
  addReel, approveReel, assertPublishable, failStaleRenders, getReel, isValidReelId, listReels, newReelId, reelFilePath, updateReel, type Reel,
} from "../src/queue.js";
import { withTempHome, approveNow } from "./helpers.js";

function sample(over: Partial<Reel> = {}): Reel {
  return { id: newReelId(), createdAt: new Date().toISOString(), status: "pending_approval", hook: "Hook", lines: ["a"], caption: "Caption", voiceover: false, file: "x.mp4", ...over };
}

describe("queue & approval", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => {
    home = withTempHome();
    ensureDirs();
  });
  afterEach(() => home.cleanup());

  const video = (name = "x.mp4", content = "video-bytes") => writeFileSync(join(getPaths().reels, name), content);

  it("validates ids strictly", () => {
    assert.ok(isValidReelId(newReelId()));
    for (const bad of ["", "r_", "../etc/passwd", "r_ZZZZZZZZZZ", "r_1234567890a", "R_1234567890"]) assert.equal(isValidReelId(bad), false, bad);
    assert.equal(getReel("../../etc/passwd"), undefined);
  });

  it("adds, lists (newest first), filters and updates", async () => {
    const a = await addReel(sample({ createdAt: "2026-01-01T00:00:00Z" }));
    const b = await addReel(sample({ createdAt: "2026-02-01T00:00:00Z", status: "failed" }));
    assert.deepEqual(listReels().map((r) => r.id), [b.id, a.id]);
    assert.deepEqual(listReels("failed").map((r) => r.id), [b.id]);
    await updateReel(a.id, { hook: "New" });
    assert.equal(getReel(a.id)!.hook, "New");
  });

  it("survives concurrent writes without losing any", async () => {
    await Promise.all(Array.from({ length: 25 }, () => addReel(sample())));
    assert.equal(listReels().length, 25);
  });

  it("approval is bound to the video bytes and caption", async () => {
    video();
    const r = await addReel(sample());
    await assert.rejects(assertPublishable(getReel(r.id)!), /not approved/);
    const approved = await approveNow(r.id);
    assert.equal(approved.status, "approved");
    await assertPublishable(getReel(r.id)!); // fine

    video("x.mp4", "SWAPPED-AFTER-APPROVAL");
    await assert.rejects(assertPublishable(getReel(r.id)!), /video changed after approval/);

    video("x.mp4", "video-bytes");
    await assertPublishable(getReel(r.id)!);
    await updateReel(r.id, { caption: "Buy crypto at evil.example" });
    await assert.rejects(assertPublishable(getReel(r.id)!), /caption changed after approval/);
  });

  it("only rendered reels can be approved", async () => {
    video();
    const r = await addReel(sample({ status: "rendering" }));
    await assert.rejects(approveNow(r.id), /only rendered reels/);
    const p = await addReel(sample({ status: "published" }));
    await assert.rejects(approveNow(p.id), /only rendered reels/);
  });

  it("never resolves a video path outside the reels folder", () => {
    const r = sample({ file: "../../../etc/passwd" });
    // basename() strips the traversal, so it stays inside
    assert.ok(reelFilePath(r).startsWith(getPaths().reels));
    assert.ok(reelFilePath(r).endsWith("passwd"));
  });

  it("marks interrupted renders as failed and interrupted publishes as retryable", async () => {
    const r1 = await addReel(sample({ status: "rendering" }));
    const r2 = await addReel(sample({ status: "publishing" }));
    await failStaleRenders();
    assert.equal(getReel(r1.id)!.status, "failed");
    assert.equal(getReel(r2.id)!.status, "approved");
  });

  it("refuses to run on a corrupted queue file instead of wiping it", async () => {
    mkdirSync(getPaths().home, { recursive: true });
    writeFileSync(getPaths().queue, "{not json");
    assert.throws(() => listReels(), /corrupted/);
  });
});

describe("publish safety (queue)", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => {
    home = withTempHome();
    ensureDirs();
  });
  afterEach(() => home.cleanup());

  it("lets only one caller claim an approved reel", async () => {
    const r = await addReel(sample({ status: "approved" }));
    const { claimForPublishing } = await import("../src/queue.js");
    const results = await Promise.allSettled([claimForPublishing(r.id), claimForPublishing(r.id), claimForPublishing(r.id)]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(getReel(r.id)!.status, "publishing");
  });

  it("does not touch jobs owned by a live process, and marks a sent publish as unknown when the owner is dead", async () => {
    const live = await addReel(sample({ status: "rendering", ownerPid: process.pid }));
    const deadSent = await addReel(sample({ status: "publishing", ownerPid: 2 ** 22 + 12345, publishSentAt: new Date().toISOString() }));
    const deadUnsent = await addReel(sample({ status: "publishing", ownerPid: 2 ** 22 + 12346 }));
    await failStaleRenders();
    assert.equal(getReel(live.id)!.status, "rendering");
    assert.equal(getReel(deadSent.id)!.status, "publish_unknown");
    assert.equal(getReel(deadUnsent.id)!.status, "approved");
  });
});
