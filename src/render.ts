import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureDirs, getPaths, type Config } from "./config.js";
import { synthesize } from "./tts.js";
import { buildTimeline, FPS, segmentTexts, type ReelText } from "./timeline.js";
import type { ReelProps, ReelTheme } from "./types.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const ReelRequestSchema = z.object({
  hook: z.string().trim().min(2).max(90),
  lines: z.array(z.string().trim().min(1).max(120)).min(1).max(7),
  cta: z.string().trim().min(1).max(70).optional(),
  caption: z.string().trim().min(1).max(2200),
  voiceover: z.boolean().default(false),
  theme: z.object({ bg: hex, fg: hex, accent: hex }).optional(),
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

  const text: ReelText = { hook: req.hook, lines: req.lines, cta: req.cta };
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

    // 2) timeline
    const tl = buildTimeline(text, { audioSeconds });
    const segments = tl.segments.map((s, i) => ({ ...s, ...(audioFiles[i] ? { audioFile: audioFiles[i] } : {}) }));
    const inputProps: ReelProps = { brandName, theme, segments, totalFrames: tl.totalFrames };

    // 3) render on this machine
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
    return { file, durationSeconds: Math.round((tl.totalFrames / FPS) * 10) / 10 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
