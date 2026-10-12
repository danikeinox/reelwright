import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigSchema } from "../src/config.js";
import { parseWav, synthesize } from "../src/tts.js";
import { makeWav, startServer } from "./helpers.js";

describe("tts", () => {
  it("reads WAV duration", () => {
    const info = parseWav(makeWav(2.5));
    assert.ok(Math.abs(info.seconds - 2.5) < 0.01);
    assert.equal(info.sampleRate, 24000);
  });

  it("handles streamed WAVs with unknown data length", () => {
    const wav = makeWav(1);
    wav.writeUInt32LE(0xffffffff, 40);
    assert.ok(Math.abs(parseWav(wav).seconds - 1) < 0.01);
  });

  it("explains non-WAV answers", () => {
    assert.throws(() => parseWav(Buffer.from("ID3\u0004mp3data".repeat(10))), /did not return a WAV/);
  });

  it("calls an OpenAI-compatible endpoint", async () => {
    const s = await startServer((q, res) => {
      if (q.url === "/v1/audio/speech") {
        res.writeHead(200, { "content-type": "audio/wav" });
        return void res.end(makeWav(1.2));
      }
      res.writeHead(404).end();
    });
    try {
      const cfg = ConfigSchema.parse({ tts: { enabled: true, baseUrl: `${s.url}/v1`, model: "voicestudio", voice: "me", apiKey: "sk-test-12345678" } });
      const r = await synthesize(cfg, "Hola mundo");
      assert.ok(Math.abs(r.info.seconds - 1.2) < 0.01);
      const sent = JSON.parse(s.requests[0]!.body);
      assert.deepEqual(sent, { model: "voicestudio", voice: "me", input: "Hola mundo", response_format: "wav" });
      assert.equal(s.requests[0]!.headers.authorization, "Bearer sk-test-12345678");
    } finally {
      await s.close();
    }
  });

  it("gives a helpful message when the voice server is down, without leaking the key", async () => {
    const cfg = ConfigSchema.parse({ tts: { enabled: true, baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-secret-abcdefgh" } });
    await assert.rejects(synthesize(cfg, "x"), (e: Error) => /Cannot reach the voice server/.test(e.message) && !e.message.includes("sk-secret"));
  });
});
