import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureDirs, getPaths, type Config } from "./config.js";
import { getLogo } from "./logo.js";
import { getMedia, getMusic, MEDIA_NAME_RE } from "./media.js";
import { synthesize } from "./tts.js";
import { buildSceneTimeline, buildTimeline, FPS, scenesSummary, segmentTexts, type ReelText } from "./timeline.js";
import type { ReelProps, ReelTheme } from "./types.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const t = (max: number) => z.string().trim().min(1).max(max);
const seconds = z.number().min(1.5).max(8).optional();

export const SceneSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title"), text: t(80), sub: t(120).optional(), seconds }),
  z.object({ type: z.literal("phone"), media: z.string().regex(MEDIA_NAME_RE, "media is a screenshot name from list_media"), text: t(70), sub: t(110).optional(), seconds }),
  z.object({
    type: z.literal("card"),
    text: t(70),
    before: t(24),
    after: t(24),
    done: t(28).optional(),
    title: t(40),
    subtitle: t(48).optional(),
    meta: t(48).optional(),
    price: t(16).optional(),
    button: t(20).optional(),
    timer: t(12).optional(),
    seconds,
  }),
  z.object({ type: z.literal("list"), text: t(60), items: z.array(t(48)).min(2).max(5), seconds }),
  z.object({ type: z.literal("price"), text: t(60).optional(), big: t(16), small: t(24).optional(), sub: t(110).optional(), seconds }),
  z.object({ type: z.literal("cta"), text: t(60), sub: t(40).optional(), note: t(70).optional(), seconds }),
]);
export type SceneRequest = z.infer<typeof SceneSchema>;

export const ReelRequestSchema = z.object({
  hook: z.string().trim().min(2).max(90).optional(),
  lines: z.array(z.string().trim().min(1).max(120)).min(1).max(7).optional(),
  scenes: z.array(SceneSchema).min(2).max(10).optional(),
  music: z.boolean().optional(),
  cta: z.string().trim().min(1).max(70).optional(),
  caption: z.string().trim().min(1).max(2200),
  voiceover: z.boolean().default(false),
  theme: z.object({ bg: hex, fg: hex, accent: hex }).optional(),
  logo: z.boolean().optional(),
}).superRefine((r, ctx) => {
  if (r.scenes) {
    if (r.voiceover) ctx.addIssue({ code: "custom", path: ["voiceover"], message: "voice-over is not available for scene reels yet" });
    for (const [i, s] of r.scenes.entries()) {
      if (s.type === "phone" && !getMedia(s.media)) {
        ctx.addIssue({ code: "custom", path: ["scenes", i, "media"], message: `no screenshot named "${s.media}" (call list_media; the user adds them with \`reelwright media add\`)` });
      }
    }
  } else if (!r.hook || !r.lines) {
    ctx.addIssue({ code: "custom", path: ["hook"], message: "give hook + lines, or scenes" });
  }
});
export type ReelRequest = z.infer<typeof ReelRequestSchema>;

/** The Remotion bundle is built at publish time and lives next to dist/. */
export function bundleDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bundle");
}

export function bundleExists(): boolean {
  return existsSync(join(bundleDir(), "index.html"));
}

/** Remotion caches the browser relative to process.cwd(): pin it to our runtime dir. */
export function useRuntimeCwd(): void {
  const { runtime } = ensureDirs();
  if (process.cwd() !== runtime) process.chdir(runtime);
}

function browserOptions(cfg: Config) {
  const exe = (process.env.REELWRIGHT_BROWSER ? resolve(process.env.REELWRIGHT_BROWSER) : "") || cfg.render.browserExecutable;
  return exe
    ? ({ browserExecutable: exe, chromeMode: "chrome-for-testing" } as const)
    : ({ chromeMode: "headless-shell" } as const);
}

/** Makes sure a usable browser exists (downloads Remotion's Chrome Headless Shell on first use). */
export async function ensureRenderBrowser(cfg: Config): Promise<string> {
  useRuntimeCwd();
  const { ensureBrowser } = await import("@remotion/renderer");
  const status = await ensureBrowser({ ...browserOptions(cfg), logLevel: "error" });
  return status.type === "no-browser" ? "none" : status.type;
}

export interface RenderResult {
  file: string;
  durationSeconds: number;
}

export async function renderReelVideo(
  id: string,
  req: ReelRequest,
  theme: ReelTheme,
  brandName: string,
  cfg: Config,
  onProgress?: (p: number) => void,
): Promise<RenderResult> {
  if (!bundleExists()) throw new Error("The Remotion bundle is missing. Reinstall Reelwright (npm i -g reelwright).");
  const paths = ensureDirs();
  useRuntimeCwd();

  const text: ReelText = req.scenes ? scenesSummary(req.scenes) : { hook: req.hook!, lines: req.lines!, cta: req.cta };
  const work = join(paths.tmp, id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const bundle = join(work, "bundle");
  cpSync(bundleDir(), bundle, { recursive: true });

  try {
    // 1) optional voice-over, one WAV per segment so the picture stays in sync with the audio
    let audioSeconds: number[] | undefined;
    const audioFiles: string[] = [];
    if (req.voiceover) {
      audioSeconds = [];
      const pub = join(bundle, "public");
      mkdirSync(pub, { recursive: true });
      const texts = segmentTexts(text);
      for (let i = 0; i < texts.length; i++) {
        const { wav, info } = await synthesize(cfg, texts[i]!.text);
        const name = `voice-${i}.wav`;
        writeFileSync(join(pub, name), wav);
        audioFiles.push(name);
        audioSeconds.push(info.seconds);
      }
    }

    // 2) optional brand logo, copied next to the voice files so the composition can load it
    let logoFile: string | undefined;
    const logo = req.logo === false ? null : getLogo();
    if (logo) {
      const pub = join(bundle, "public");
      mkdirSync(pub, { recursive: true });
      logoFile = `logo.${logo.ext}`;
      cpSync(logo.file, join(pub, logoFile));
    }

    // 3) screenshots and music for scene reels
    const pubDir = join(bundle, "public");
    const media: Record<string, string> = {};
    let musicFile: string | undefined;
    if (req.scenes) {
      mkdirSync(pubDir, { recursive: true });
      for (const s of req.scenes) {
        if (s.type !== "phone" || media[s.media]) continue;
        const m = getMedia(s.media);
        if (!m) throw new Error(`Screenshot "${s.media}" is missing from the media library`);
        media[s.media] = `media-${m.name}.${m.ext}`;
        cpSync(m.file, join(pubDir, media[s.media]!));
      }
    }
    const music = req.music === false ? null : req.scenes || req.music ? getMusic() : null;
    if (music) {
      mkdirSync(pubDir, { recursive: true });
      musicFile = `music.${music.ext}`;
      cpSync(music.file, join(pubDir, musicFile));
    }

    // 4) timeline
    let inputProps: ReelProps;
    let totalFrames: number;
    if (req.scenes) {
      const st = buildSceneTimeline(req.scenes);
      totalFrames = st.totalFrames;
      inputProps = { brandName, theme, segments: [], totalFrames, scenes: st.scenes, media, ...(logoFile ? { logoFile } : {}), ...(musicFile ? { musicFile } : {}) };
    } else {
      const tl = buildTimeline(text, { audioSeconds });
      totalFrames = tl.totalFrames;
      const segments = tl.segments.map((s, i) => ({ ...s, ...(audioFiles[i] ? { audioFile: audioFiles[i] } : {}) }));
      inputProps = { brandName, theme, segments, totalFrames, ...(logoFile ? { logoFile } : {}), ...(musicFile ? { musicFile } : {}) };
    }

    // 5) render on this machine
    const { selectComposition, renderMedia } = await import("@remotion/renderer");
    const browser = browserOptions(cfg);
    try {
      await ensureRenderBrowser(cfg);
    } catch (e) {
      throw new Error(
        `Could not prepare the rendering browser: ${(e as Error).message}. Run \`reelwright setup\` — it can also use a Chrome/Edge you already have installed.`,
      );
    }
    const composition = await selectComposition({
      serveUrl: bundle,
      id: "Reel",
      inputProps,
      logLevel: "error",
      ...browser,
    });
    const file = `${id}.mp4`;
    const outputLocation = join(paths.reels, file);
    let last = 0;
    await renderMedia({
      composition,
      serveUrl: bundle,
      codec: "h264",
      audioCodec: "aac",
      enforceAudioTrack: true,
      pixelFormat: "yuv420p",
      crf: 20,
      inputProps,
      outputLocation,
      overwrite: true,
      logLevel: "error",
      ...(cfg.render.concurrency ? { concurrency: cfg.render.concurrency } : {}),
      ...browser,
      onProgress: ({ progress }) => {
        if (onProgress && progress - last >= 0.05) {
          last = progress;
          onProgress(progress);
        }
      },
    });
    if (!existsSync(outputLocation) || statSync(outputLocation).size < 1000) throw new Error("The renderer produced no video");
    return { file, durationSeconds: Math.round((totalFrames / FPS) * 10) / 10 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
