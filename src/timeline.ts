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

// ---------- rich reels (scenes) ----------

import type { Scene, TimedScene } from "./types.js";

/** Default length of each scene, tuned so text can be read on a phone. */
export function sceneSeconds(s: Scene): number {
  const read = (t: string | undefined) => (t ? t.length * 0.05 : 0);
  switch (s.type) {
    case "title":
      return clamp(1.6 + read(s.text) + read(s.sub), 2.2, 4);
    case "phone":
      return clamp(2.4 + read(s.text) + read(s.sub), 3.2, 5);
    case "card":
      return clamp(4.4 + read(s.text), 4.8, 6.5);
    case "list":
      return clamp(1.6 + s.items.length * 0.75 + read(s.text), 3, 6);
    case "price":
      return clamp(2.2 + read(s.text) + read(s.sub), 2.8, 4.5);
    case "cta":
      return clamp(2.6 + read(s.text) + read(s.sub) + read(s.note), 3.2, 5);
  }
}

export function buildSceneTimeline(scenes: Array<Scene & { seconds?: number }>) {
  let cursor = 0;
  const out: TimedScene[] = scenes.map(({ seconds, ...s }) => {
    const duration = sec(seconds ?? sceneSeconds(s as Scene));
    const t = { ...(s as Scene), start: cursor, duration } as TimedScene;
    cursor += duration;
    return t;
  });
  const totalFrames = cursor + sec(0.2);
  const total = totalFrames / FPS;
  if (total > MAX_SECONDS) throw new Error(`The reel would last ${total.toFixed(0)}s; the maximum is ${MAX_SECONDS}s. Use fewer scenes.`);
  return { scenes: out, totalFrames, seconds: total };
}

/** Plain-text summary of a scene reel, for the review panel and the queue. */
export function scenesSummary(scenes: Scene[]): { hook: string; lines: string[]; cta?: string } {
  const texts = scenes.map((s) => (s.type === "price" ? [s.text, s.big].filter(Boolean).join(" ") : s.text) as string);
  const last = scenes[scenes.length - 1];
  const cta = last?.type === "cta" ? last.text : undefined;
  return { hook: texts[0] ?? "", lines: texts.slice(1, cta ? -1 : undefined), cta };
}
