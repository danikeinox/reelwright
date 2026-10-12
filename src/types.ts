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
};
