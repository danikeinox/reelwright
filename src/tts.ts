import type { Config } from "./config.js";
import { redact } from "./config.js";

export interface WavInfo {
  seconds: number;
  sampleRate: number;
  channels: number;
}

/** Reads the duration from a PCM WAV without any dependency. */
export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(
      "The voice server did not return a WAV file. Configure your TTS engine to answer with WAV (response_format=wav).",
    );
  }
  let offset = 12;
  let byteRate = 0;
  let sampleRate = 0;
  let channels = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
    } else if (id === "data") {
      if (size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streamed WAVs
      if (!byteRate) throw new Error("Malformed WAV (data before fmt)");
      return { seconds: size / byteRate, sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("Malformed WAV (no data chunk)");
}

export async function synthesize(cfg: Config, text: string): Promise<{ wav: Buffer; info: WavInfo }> {
  const tts = cfg.tts;
  if (!tts.enabled || !tts.baseUrl) throw new Error("Voice-over is not configured (see `reelwright setup`).");
  const url = `${tts.baseUrl.replace(/\/+$/, "")}/audio/speech`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(tts.apiKey ? { authorization: `Bearer ${tts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: tts.model, voice: tts.voice, input: text, response_format: "wav" }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Error(
      `Cannot reach the voice server at ${tts.baseUrl}: ${redact((e as Error).message, cfg)}. Is VoiceStudio (or your TTS) running?`,
    );
  }
  if (!res.ok) {
    const detail = redact((await res.text()).slice(0, 300), cfg);
    throw new Error(`Voice server answered HTTP ${res.status}: ${detail}`);
  }
  const wav = Buffer.from(await res.arrayBuffer());
  return { wav, info: parseWav(wav) };
}
