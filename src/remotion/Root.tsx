import React from "react";
import { Composition } from "remotion";
import { Reel } from "./Reel";
import type { ReelProps } from "../types";

export const DEFAULT_PROPS: ReelProps = {
  brandName: "Reelwright",
  theme: { bg: "#10121a", fg: "#ffffff", accent: "#ff5a1f" },
  segments: [
    { kind: "hook", text: "Your website, as a reel", start: 0, duration: 75 },
    { kind: "line", text: "Rendered on your own machine", start: 75, duration: 75 },
    { kind: "cta", text: "You approve. Then it posts.", start: 150, duration: 75 },
  ],
  totalFrames: 225,
};

export const Root: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={DEFAULT_PROPS.totalFrames}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={({ props }) => ({ durationInFrames: Math.max(30, props.totalFrames) })}
  />
);
