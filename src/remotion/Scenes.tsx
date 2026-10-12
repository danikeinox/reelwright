import React from "react";
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { ReelProps, ReelTheme, TimedScene } from "../types";
import { FONT, useInterFont, useTrimmedLogo } from "./shared";

/**
 * Rich reels: designed scenes (headline, phone with a screenshot, animated status card,
 * checklist, price, closing call to action) with motion between them.
 *
 * Layout respects Instagram's overlays: nothing important above y≈220 (top bar) or
 * below y≈1560 on the left/bottom (caption, buttons).
 */

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const MUTED = "rgba(255,255,255,0.62)";

type SceneProps<T extends TimedScene["type"]> = {
  scene: Extract<TimedScene, { type: T }>;
  theme: ReelTheme;
  logo: string | null;
  media: Record<string, string>;
};

/** Words rise out of a mask one after another. */
const Kinetic: React.FC<{ text: string; size: number; weight?: number; color: string; delay?: number; align?: "center" | "left" }> = ({
  text,
  size,
  weight = 800,
  color,
  delay = 0,
  align = "center",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        columnGap: size * 0.26,
        rowGap: size * 0.02,
        textAlign: align,
      }}
    >
      {words.map((w, i) => {
        const p = spring({ frame: frame - delay - i * 2.5, fps, config: { damping: 18, stiffness: 160, mass: 0.6 } });
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: size * 0.08, marginBottom: -size * 0.08 }}>
            <span
              style={{
                display: "inline-block",
                fontFamily: FONT,
                fontWeight: weight,
                fontSize: size,
                lineHeight: 1.04,
                letterSpacing: "-0.035em",
                color,
                transform: `translateY(${(1 - p) * 105}%)`,
              }}
            >
              {w}
            </span>
          </span>
        );
      })}
    </div>
  );
};

const Fade: React.FC<{ delay?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ delay = 0, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 20, stiffness: 120 } });
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * 24}px)`, ...style }}>{children}</div>;
};

const Logo: React.FC<{ src: string | null; width: number; delay?: number }> = ({ src, width, delay = 0 }) =>
  src ? (
    <Fade delay={delay} style={{ display: "flex", justifyContent: "center" }}>
      <Img src={src} style={{ maxWidth: width, maxHeight: width * 0.4, objectFit: "contain" }} />
    </Fade>
  ) : null;

// ---------------- scenes ----------------

const TitleScene: React.FC<SceneProps<"title"> & { first: boolean }> = ({ scene, logo, first }) => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, scene.duration], [1, 1.05]);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 90px 120px" }}>
      {first ? (
        <div style={{ position: "absolute", top: 300, width: "100%" }}>
          <Logo src={logo} width={420} />
        </div>
      ) : null}
      <div style={{ transform: `scale(${zoom})` }}>
        <Kinetic text={scene.text} size={scene.text.length > 40 ? 104 : 128} color="#ffffff" delay={4} />
        {scene.sub ? (
          <Fade delay={16} style={{ marginTop: 44, textAlign: "center", fontFamily: FONT, fontWeight: 500, fontSize: 46, lineHeight: 1.3, color: MUTED }}>
            {scene.sub}
          </Fade>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const PhoneScene: React.FC<SceneProps<"phone">> = ({ scene, media }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 3, fps, config: { damping: 16, stiffness: 80, mass: 1 } });
  const t = frame / scene.duration;
  const rotY = interpolate(enter, [0, 1], [32, -7]) + Math.sin(frame / 34) * 2.5;
  const rotX = interpolate(enter, [0, 1], [18, 6]);
  const y = interpolate(enter, [0, 1], [700, 0]) + Math.sin(frame / 28) * 8;
  const zoom = interpolate(t, [0, 1], [1, 1.06]);
  const file = media[scene.media];
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 240, left: 70, right: 70 }}>
        <Kinetic text={scene.text} size={scene.text.length > 34 ? 74 : 86} color="#ffffff" />
        {scene.sub ? (
          <Fade delay={12} style={{ marginTop: 22, textAlign: "center", fontFamily: FONT, fontWeight: 500, fontSize: 38, lineHeight: 1.3, color: MUTED }}>
            {scene.sub}
          </Fade>
        ) : null}
      </div>
      <div style={{ position: "absolute", top: scene.sub ? 600 : 540, width: "100%", display: "flex", justifyContent: "center", perspective: 2400 }}>
        <div
          style={{
            width: 620,
            transform: `translateY(${y}px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${zoom})`,
            transformStyle: "preserve-3d",
            borderRadius: 80,
            padding: 13,
            background: "linear-gradient(145deg, #3a3a3a, #121212 45%, #2a2a2a)",
            boxShadow: "0 60px 120px rgba(0,0,0,0.65), 0 0 0 2px rgba(255,255,255,0.08)",
          }}
        >
          {file ? <Img src={staticFile(file)} style={{ width: "100%", display: "block", borderRadius: 66 }} /> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CardScene: React.FC<SceneProps<"card">> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const d = scene.duration;
  const enter = spring({ frame: frame - 6, fps, config: { damping: 15, stiffness: 110 } });
  const flipAt = Math.round(d * 0.3);
  const tapAt = Math.round(d * 0.62);
  const doneAt = tapAt + 10;
  const flip = spring({ frame: frame - flipAt, fps, config: { damping: 12, stiffness: 140 } });
  const isLive = frame >= flipAt;
  const isDone = frame >= doneAt;
  const pulse = isLive && !isDone ? 0.5 + 0.5 * Math.sin((frame - flipAt) / 5) : 0;
  const bump = 1 + interpolate(frame, [flipAt, flipAt + 6, flipAt + 14], [0, 0.04, 0], clamp) + interpolate(frame, [doneAt, doneAt + 5, doneAt + 12], [0, 0.025, 0], clamp);
  const tap = interpolate(frame, [tapAt - 14, tapAt, tapAt + 8], [0, 1, 0], clamp);
  const ring = interpolate(frame, [tapAt, tapAt + 16], [0, 1], clamp);
  const accent = theme.accent;
  const label = isDone ? scene.done ?? scene.after : isLive ? scene.after : scene.before;
  const labelColor = isLive ? accent : "rgba(255,255,255,0.5)";

  // "12 min" counts down a little while the slot is live
  const timerMatch = scene.timer?.match(/^(\d+)(.*)$/);
  const timer = timerMatch && isLive ? `${Math.max(1, Number(timerMatch[1]) - Math.floor((frame - flipAt) / 30))}${timerMatch[2]}` : scene.timer;

  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 330, left: 80, right: 80 }}>
        <Kinetic text={scene.text} size={scene.text.length > 34 ? 80 : 92} color="#ffffff" />
      </div>
      <div style={{ position: "absolute", top: 760, width: "100%", display: "flex", justifyContent: "center" }}>
        <div
          style={{
            width: 880,
            padding: "54px 56px",
            borderRadius: 48,
            background: "#1a1a1a",
            border: `3px solid ${isLive ? accent : "#2e2e2e"}`,
            boxShadow: isLive ? `0 0 ${40 + pulse * 50}px ${accent}${isDone ? "40" : "55"}` : "0 40px 90px rgba(0,0,0,0.5)",
            opacity: enter,
            transform: `translateY(${(1 - enter) * 160}px) scale(${bump}) rotateX(${(1 - flip) * (isLive ? 25 : 0)}deg)`,
            fontFamily: FONT,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: labelColor }}>
              <span style={{ width: 16, height: 16, borderRadius: 8, background: labelColor, opacity: isLive ? 0.6 + pulse * 0.4 : 1 }} />
              {label}
            </div>
            {timer && isLive && !isDone ? <div style={{ fontSize: 34, fontWeight: 700, color: accent }}>{timer}</div> : null}
          </div>
          <div style={{ marginTop: 34, fontSize: 60, fontWeight: 700, color: "#fff", letterSpacing: "-0.02em", opacity: isLive ? 1 : 0.55, textDecoration: isLive ? "none" : "line-through", textDecorationThickness: 4 }}>
            {scene.title}
          </div>
          {scene.subtitle ? <div style={{ marginTop: 10, fontSize: 40, color: MUTED }}>{scene.subtitle}</div> : null}
          {scene.meta || scene.price ? (
            <div style={{ marginTop: 40, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: MUTED }}>{scene.meta ?? ""}</div>
              <div style={{ fontSize: 50, fontWeight: 800, color: "#fff" }}>{scene.price ?? ""}</div>
            </div>
          ) : null}
          {scene.button ? (
            <div style={{ position: "relative", marginTop: 44 }}>
              <div
                style={{
                  height: 112,
                  borderRadius: 28,
                  border: "3px solid #fff",
                  background: isDone ? "#fff" : "transparent",
                  color: isDone ? theme.bg : "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 42,
                  fontWeight: 700,
                  opacity: isLive ? 1 : 0.35,
                  transform: `scale(${1 - tap * 0.05})`,
                }}
              >
                {isDone ? "✓" : scene.button}
              </div>
              {/* finger tap */}
              <div
                style={{
                  position: "absolute",
                  left: "58%",
                  top: 56,
                  width: 90,
                  height: 90,
                  marginLeft: -45,
                  marginTop: -45,
                  borderRadius: 45,
                  background: "rgba(255,255,255,0.85)",
                  opacity: tap * 0.9,
                  transform: `scale(${0.6 + tap * 0.4})`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: "58%",
                  top: 56,
                  width: 90,
                  height: 90,
                  marginLeft: -45,
                  marginTop: -45,
                  borderRadius: 45,
                  border: "4px solid #fff",
                  opacity: ring > 0 ? 1 - ring : 0,
                  transform: `scale(${1 + ring * 2.2})`,
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const ListScene: React.FC<SceneProps<"list">> = ({ scene, theme }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 300, left: 90, right: 90 }}>
        <Kinetic text={scene.text} size={scene.text.length > 30 ? 80 : 92} color="#ffffff" align="left" />
      </div>
      <div style={{ position: "absolute", top: scene.text.length > 30 ? 640 : 560, left: 90, right: 90, display: "flex", flexDirection: "column", gap: 34 }}>
        {scene.items.map((item, i) => {
          const p = spring({ frame: frame - 14 - i * 9, fps, config: { damping: 16, stiffness: 130 } });
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 30,
                padding: "30px 34px",
                borderRadius: 32,
                background: "#1c1b1b",
                border: "2px solid #2a2a2a",
                opacity: p,
                transform: `translateX(${(1 - p) * -120}px)`,
              }}
            >
              <div
                style={{
                  flex: "0 0 auto",
                  width: 60,
                  height: 60,
                  borderRadius: 30,
                  background: theme.accent,
                  color: theme.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 36,
                  fontWeight: 900,
                  transform: `scale(${p})`,
                }}
              >
                ✓
              </div>
              <div style={{ fontFamily: FONT, fontSize: 46, fontWeight: 650, color: "#fff", lineHeight: 1.2, letterSpacing: "-0.01em" }}>{item}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const PriceScene: React.FC<SceneProps<"price">> = ({ scene }) => {
  const frame = useCurrentFrame();
  const m = scene.big.match(/^(\D*)(\d+)(.*)$/);
  const count = m ? Math.round(interpolate(frame, [6, 30], [0, Number(m[2])], { ...clamp, easing: Easing.out(Easing.cubic) })) : 0;
  const big = m ? `${m[1]}${count}${m[3]}` : scene.big;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 80px 140px" }}>
      {scene.text ? (
        <Fade style={{ fontFamily: FONT, fontSize: 50, fontWeight: 600, color: MUTED, textAlign: "center", marginBottom: 20 }}>{scene.text}</Fade>
      ) : null}
      <Fade delay={4} style={{ display: "flex", alignItems: "baseline", gap: 18, fontFamily: FONT }}>
        <span style={{ fontSize: 250, fontWeight: 800, color: "#fff", letterSpacing: "-0.05em", fontVariantNumeric: "tabular-nums" }}>{big}</span>
        {scene.small ? <span style={{ fontSize: 58, fontWeight: 600, color: MUTED }}>{scene.small}</span> : null}
      </Fade>
      {scene.sub ? (
        <Fade delay={18} style={{ marginTop: 26, fontFamily: FONT, fontSize: 42, lineHeight: 1.35, fontWeight: 500, color: MUTED, textAlign: "center" }}>
          {scene.sub}
        </Fade>
      ) : null}
    </AbsoluteFill>
  );
};

const CtaScene: React.FC<SceneProps<"cta">> = ({ scene, theme, logo }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const btn = spring({ frame: frame - 20, fps, config: { damping: 13, stiffness: 120 } });
  const glow = 0.5 + 0.5 * Math.sin(frame / 8);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: "0 90px 160px" }}>
      <Logo src={logo} width={560} />
      <div style={{ marginTop: logo ? 90 : 0 }}>
        <Kinetic text={scene.text} size={scene.text.length > 32 ? 82 : 96} color="#ffffff" delay={6} />
      </div>
      {scene.sub ? (
        <div
          style={{
            marginTop: 70,
            padding: "34px 64px",
            borderRadius: 999,
            background: "#ffffff",
            color: theme.bg,
            fontFamily: FONT,
            fontSize: 46,
            fontWeight: 700,
            textAlign: "center",
            opacity: btn,
            transform: `scale(${0.7 + btn * 0.3})`,
            boxShadow: `0 0 ${30 + glow * 30}px rgba(255,255,255,${0.15 + glow * 0.12})`,
          }}
        >
          {scene.sub}
        </div>
      ) : null}
      {scene.note ? (
        <Fade delay={30} style={{ marginTop: 36, fontFamily: FONT, fontSize: 40, fontWeight: 500, color: MUTED, textAlign: "center" }}>
          {scene.note}
        </Fade>
      ) : null}
    </AbsoluteFill>
  );
};

// ---------------- composition ----------------

const OVERLAP = 8;

const SceneFrame: React.FC<{ duration: number; last: boolean; children: React.ReactNode }> = ({ duration, last, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 140 } });
  const out = last ? 0 : interpolate(frame, [duration - 9, duration], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(enter * 1.4, 1) * (1 - out),
        transform: `translateY(${(1 - enter) * 50 - out * 70}px) scale(${1 + out * 0.06})`,
        filter: out > 0 ? `blur(${out * 14}px)` : undefined,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const SceneReel: React.FC<ReelProps> = ({ theme, scenes = [], totalFrames, logoFile, media = {}, musicFile }) => {
  useInterFont();
  const logo = useTrimmedLogo(logoFile);
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 50);

  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${theme.bg} 0%, #070707 100%)`, fontFamily: FONT }}>
      {/* soft light that slowly moves, like a studio backdrop */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at ${50 + drift * 18}% ${30 + drift * 6}%, rgba(255,255,255,0.075) 0%, transparent 55%)`,
        }}
      />
      {musicFile ? (
        <Audio
          src={staticFile(musicFile)}
          volume={(f) => interpolate(f, [0, 12, totalFrames - 36, totalFrames], [0, 0.55, 0.55, 0], clamp)}
        />
      ) : null}
      {scenes.map((s, i) => {
        const last = i === scenes.length - 1;
        const common = { theme, logo, media } as const;
        let body: React.ReactNode = null;
        switch (s.type) {
          case "title":
            body = <TitleScene scene={s} {...common} first={i === 0} />;
            break;
          case "phone":
            body = <PhoneScene scene={s} {...common} />;
            break;
          case "card":
            body = <CardScene scene={s} {...common} />;
            break;
          case "list":
            body = <ListScene scene={s} {...common} />;
            break;
          case "price":
            body = <PriceScene scene={s} {...common} />;
            break;
          case "cta":
            body = <CtaScene scene={s} {...common} />;
            break;
        }
        const lead = i === 0 ? 0 : OVERLAP;
        const from = s.start - lead;
        const length = last ? totalFrames - from : s.duration + lead;
        return (
          <Sequence key={i} from={from} durationInFrames={length} layout="none">
            <SceneFrame duration={length} last={last}>
              {body}
            </SceneFrame>
          </Sequence>
        );
      })}
      {/* progress */}
      <div style={{ position: "absolute", top: 0, left: 0, height: 8, width: `${(frame / totalFrames) * 100}%`, background: "rgba(255,255,255,0.9)" }} />
    </AbsoluteFill>
  );
};
