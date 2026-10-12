import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addMedia, getMedia, getMusic, listMedia, removeMedia, removeMusic, setMusic, slugify, sniffAudio } from "../src/media.js";
import { ReelRequestSchema } from "../src/render.js";
import { buildSceneTimeline, scenesSummary } from "../src/timeline.js";
import { withTempHome } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(32)]);

describe("scenes and media", () => {
  let home: ReturnType<typeof withTempHome>;
  beforeEach(() => (home = withTempHome()));
  afterEach(() => home.cleanup());

  const file = (name: string, data: Buffer) => {
    const dir = join(home.dir, "src");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  it("keeps a library of screenshots by safe name", () => {
    assert.equal(slugify("Pantalla Carrito (v2).PNG"), "pantalla-carrito-v2");
    addMedia(file("Carrito Final.png", PNG));
    addMedia(file("x.png", PNG), "panel");
    assert.deepEqual(listMedia().map((m) => m.name), ["carrito-final", "panel"]);
    assert.ok(getMedia("panel"));
    assert.equal(getMedia("../config"), null);
    assert.equal(getMedia("PANEL"), null);
    assert.throws(() => addMedia(file("a.svg", Buffer.from("<svg/>"))), /PNG, WebP or JPEG/);
    assert.equal(removeMedia("panel"), true);
    assert.equal(getMedia("panel"), null);
  });

  it("stores one background music file", () => {
    assert.equal(sniffAudio(WAV), "wav");
    assert.equal(sniffAudio(Buffer.from("ID3\x04\x00")), "mp3");
    assert.equal(sniffAudio(Buffer.from("hello world, not audio")), null);
    assert.equal(getMusic(), null);
    setMusic(file("beat.wav", WAV));
    assert.equal(getMusic()?.ext, "wav");
    assert.throws(() => setMusic(file("x.txt", Buffer.from("nope"))), /WAV, MP3 or M4A/);
    assert.equal(removeMusic(), true);
    assert.equal(getMusic(), null);
  });

  it("validates scene requests", () => {
    addMedia(file("carrito.png", PNG));
    const ok = ReelRequestSchema.parse({
      caption: "c",
      scenes: [
        { type: "title", text: "Hola" },
        { type: "phone", media: "carrito", text: "Mira" },
        { type: "card", text: "Oferta", before: "Agotado", after: "Disponible", title: "Zapatillas" },
        { type: "list", text: "Todo", items: ["a", "b"] },
        { type: "price", big: "29 €" },
        { type: "cta", text: "Ven", sub: "web.com", note: "o por MD" },
      ],
    });
    assert.equal(ok.scenes?.length, 6);
    // unknown screenshot, paths and voice-over are refused
    assert.throws(() => ReelRequestSchema.parse({ caption: "c", scenes: [{ type: "title", text: "a" }, { type: "phone", media: "nope", text: "b" }] }), /no screenshot named/);
    assert.throws(() => ReelRequestSchema.parse({ caption: "c", scenes: [{ type: "title", text: "a" }, { type: "phone", media: "../../etc/passwd", text: "b" }] }), /media/);
    assert.throws(() => ReelRequestSchema.parse({ caption: "c", voiceover: true, scenes: [{ type: "title", text: "a" }, { type: "cta", text: "b" }] }), /voice-over/);
    assert.throws(() => ReelRequestSchema.parse({ caption: "c", scenes: [{ type: "video", text: "a" }, { type: "cta", text: "b" }] }));
    // a request needs either hook + lines or scenes
    assert.throws(() => ReelRequestSchema.parse({ caption: "c" }), /hook \+ lines, or scenes/);
    assert.ok(ReelRequestSchema.parse({ caption: "c", hook: "Hola", lines: ["a"] }));
  });

  it("times scenes and summarises them for review", () => {
    const scenes = [
      { type: "title" as const, text: "Hola" },
      { type: "list" as const, text: "Todo", items: ["a", "b", "c"], seconds: 4 },
      { type: "cta" as const, text: "Ven" },
    ];
    const tl = buildSceneTimeline(scenes);
    assert.equal(tl.scenes[0]!.start, 0);
    assert.equal(tl.scenes[1]!.start, tl.scenes[0]!.duration);
    assert.equal(tl.scenes[1]!.duration, 120);
    assert.ok(tl.totalFrames > tl.scenes[2]!.start + tl.scenes[2]!.duration - 1);
    assert.deepEqual(scenesSummary(scenes), { hook: "Hola", lines: ["Todo"], cta: "Ven" });
  });
});
