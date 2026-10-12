import type { Segment } from "./types.js";

export const FPS = 30;
export const MAX_SECONDS = 90;

export interface ReelText {
  hook: string;
  lines: string[];
  cta?: string;
}

export interface TimelineOptions {
  /** voice-over duration (seconds) per segment, in order: hook, lines..., cta. */
  audioSeconds?: number[];
}

const sec = (s: number) => Math.round(s * FPS);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function segmentTexts(t: ReelText): Array<Pick<Segment, "kind" | "text">> {
  return [
    { kind: "hook", text: t.hook },
    ...t.lines.map((text) => ({ kind: "line" as const, text })),
    ...(t.cta ? [{ kind: "cta" as const, text: t.cta }] : []),
  ];
}

export function buildTimeline(t: ReelText, opts: TimelineOptions = {}) {
  const texts = segmentTexts(t);
  let cursor = 0;
  const segments: Segment[] = texts.map((s, i) => {
    const audio = opts.audioSeconds?.[i];
    const seconds =
      audio !== undefined
        ? Math.max(1.8, audio + 0.45)
        : s.kind === "hook"
          ? clamp(s.text.length * 0.06, 2.4, 4)
          : s.kind === "cta"
            ? 2.8
            : clamp(s.text.length * 0.065, 2.2, 4.5);
    const duration = sec(seconds);
    const seg: Segment = { ...s, start: cursor, duration };
    cursor += duration;
    return seg;
  });
  const totalFrames = cursor + sec(0.3);
  const seconds = totalFrames / FPS;
  if (seconds > MAX_SECONDS) {
    throw new Error(`The reel would last ${seconds.toFixed(0)}s; the maximum is ${MAX_SECONDS}s. Use fewer or shorter lines.`);
  }
  return { segments, totalFrames, seconds };
}
