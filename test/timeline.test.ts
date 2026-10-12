import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimeline, FPS } from "../src/timeline.js";

describe("timeline", () => {
  const text = { hook: "Fresh bread daily", lines: ["Baked at 4am", "Wood-fired oven"], cta: "Order now" };

  it("lays segments back to back without gaps", () => {
    const t = buildTimeline(text);
    assert.equal(t.segments.length, 4);
    let cursor = 0;
    for (const s of t.segments) {
      assert.equal(s.start, cursor);
      assert.ok(s.duration >= 2 * FPS);
      cursor += s.duration;
    }
    assert.ok(t.totalFrames > cursor);
    assert.deepEqual(t.segments.map((s) => s.kind), ["hook", "line", "line", "cta"]);
  });

  it("sizes segments from the voice-over when present", () => {
    const t = buildTimeline(text, { audioSeconds: [1, 6, 1, 3] });
    assert.equal(t.segments[1]!.duration, Math.round(6.45 * FPS));
    assert.equal(t.segments[0]!.duration, Math.round(1.8 * FPS), "short audio still gets a readable minimum");
  });

  it("omits the cta segment when there is none", () => {
    assert.equal(buildTimeline({ hook: "Hello there", lines: ["One"] }).segments.length, 2);
  });

  it("refuses reels longer than 90 seconds", () => {
    assert.throws(() => buildTimeline(text, { audioSeconds: [30, 30, 30, 30] }), /maximum is 90s/);
  });
});
