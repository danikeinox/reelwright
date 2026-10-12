import "@fontsource-variable/inter/index.css";
import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import type { ReelProps, Segment } from "../types";
export type { ReelProps, Segment } from "../types";

const FONT = '"Inter Variable", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function useInterFont(): void {
  const [handle] = useState(() => delayRender("Loading Inter"));
  useEffect(() => {
    Promise.all([document.fonts.load('800 80px "Inter Variable"'), document.fonts.load('600 80px "Inter Variable"')])
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle]);
}

function fontSizeFor(kind: Segment["kind"], text: string): number {
  const base = kind === "hook" ? 112 : kind === "line" ? 88 : 72;
  const factor = Math.min(1, Math.sqrt(30 / Math.max(text.length, 1)));
  return Math.max(54, Math.round(base * factor));
}

const SegmentView: React.FC<{ seg: Segment; theme: ReelProps["theme"] }> = ({ seg, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = seg.text.split(/\s+/).filter(Boolean);
  const out = interpolate(frame, [seg.duration - 8, seg.duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const size = fontSizeFor(seg.kind, seg.text);
  const isCta = seg.kind === "cta";

  const content = (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: `${Math.round(size * 0.22)}px ${Math.round(size * 0.28)}px`,
        textAlign: "center",
      }}
    >
      {words.map((word, i) => {
        const p = spring({ frame: frame - i * 3, fps, config: { damping: 14, stiffness: 140, mass: 0.7 } });
        return (
          <span
            key={`${word}-${i}`}
            style={{
              display: "inline-block",
              fontFamily: FONT,
              fontWeight: seg.kind === "hook" ? 800 : 700,
              fontSize: size,
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
              color: isCta ? theme.bg : seg.kind === "hook" ? theme.fg : theme.fg,
              opacity: p,
              transform: `translateY(${(1 - p) * 46}px) scale(${0.9 + p * 0.1})`,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 96px 220px", opacity: out }}>
      {seg.audioFile ? <Audio src={staticFile(seg.audioFile)} /> : null}
      {isCta ? (
        <div style={{ background: theme.accent, borderRadius: 72, padding: "44px 64px" }}>{content}</div>
      ) : (
        content
      )}
    </AbsoluteFill>
  );
};

export const Reel: React.FC<ReelProps> = ({ brandName, theme, segments, totalFrames }) => {
  useInterFont();
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 40);

  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${theme.bg} 0%, #000000 140%)`, fontFamily: FONT }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${30 + drift * 10}% ${22 + drift * 4}%, ${theme.accent}55 0%, transparent 46%),
                       radial-gradient(circle at ${78 - drift * 8}% ${82 - drift * 5}%, ${theme.accent}33 0%, transparent 42%)`,
        }}
      />
      <div style={{ position: "absolute", top: 0, left: 0, height: 10, width: `${(frame / totalFrames) * 100}%`, background: theme.accent }} />
      {segments.map((seg, i) => (
        <Sequence key={i} from={seg.start} durationInFrames={seg.duration} layout="none">
          <SegmentView seg={seg} theme={theme} />
        </Sequence>
      ))}
      <div
        style={{
          position: "absolute",
          bottom: 330,
          width: "100%",
          textAlign: "center",
          fontSize: 34,
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: theme.fg,
          opacity: 0.6,
        }}
      >
        {brandName}
      </div>
    </AbsoluteFill>
  );
};
