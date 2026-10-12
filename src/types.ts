/** Shared by the Node side and the Remotion composition (keep this file dependency-free). */
export type Segment = {
  kind: "hook" | "line" | "cta";
  text: string;
  /** first frame, relative to the start of the reel */
  start: number;
  duration: number;
  /** file inside the bundle's public/ folder with the voice-over for this segment */
  audioFile?: string;
};

export type ReelTheme = { bg: string; fg: string; accent: string };

export type ReelProps = {
  brandName: string;
  theme: ReelTheme;
  segments: Segment[];
  totalFrames: number;
  /** file inside the bundle's public/ folder with the brand logo (set by the human with `reelwright logo`) */
  logoFile?: string;
  /** when present, the reel is drawn from these scenes and `segments` is empty */
  scenes?: TimedScene[];
  /** files inside the bundle's public/ folder: one per phone scene media name */
  media?: Record<string, string>;
  /** background music file inside the bundle's public/ folder */
  musicFile?: string;
};

/** Rich reels: a sequence of designed scenes instead of plain text lines. */
export type Scene =
  | { type: "title"; text: string; sub?: string }
  | { type: "phone"; media: string; text: string; sub?: string }
  | {
      type: "card";
      text: string;
      before: string;
      after: string;
      done?: string;
      title: string;
      subtitle?: string;
      meta?: string;
      price?: string;
      button?: string;
      timer?: string;
    }
  | { type: "list"; text: string; items: string[] }
  | { type: "price"; text?: string; big: string; small?: string; sub?: string }
  | { type: "cta"; text: string; sub?: string; note?: string };

export type TimedScene = Scene & { start: number; duration: number };
