import { getBrand } from "./brand.js";
import { loadConfig, redact } from "./config.js";
import { addReel, newReelId, updateReel, type Reel } from "./queue.js";
import { renderReelVideo, type ReelRequest } from "./render.js";
import type { ReelTheme } from "./types.js";

const FALLBACK_THEME: ReelTheme = { bg: "#10121a", fg: "#ffffff", accent: "#ff5a1f" };

const RENDER_TIMEOUT_MS = 15 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Rendering is CPU-heavy: one at a time.
let chain: Promise<unknown> = Promise.resolve();

/** Registers the reel and renders in the background so the MCP call returns immediately. */
export async function startRender(req: ReelRequest): Promise<Reel> {
  const cfg = loadConfig();
  const brand = getBrand();
  const theme = req.theme ?? cfg.defaultTheme ?? brand?.theme ?? FALLBACK_THEME;
  const brandName = brand?.name ?? "";
  const id = newReelId();
  const reel = await addReel({
    id,
    createdAt: new Date().toISOString(),
    status: "rendering",
    hook: req.hook,
    lines: req.lines,
    cta: req.cta,
    caption: req.caption,
    voiceover: req.voiceover,
    progress: 0,
  });
  chain = chain.then(async () => {
    try {
      const out = await withTimeout(
        renderReelVideo(id, req, theme, brandName, cfg, (p) => void updateReel(id, { progress: p }).catch(() => undefined)),
        RENDER_TIMEOUT_MS,
        "The render took longer than 15 minutes and was abandoned (is the computer very busy?)",
      );
      await updateReel(id, { status: "pending_approval", file: out.file, durationSeconds: out.durationSeconds, progress: 1, error: undefined });
    } catch (e) {
      await updateReel(id, { status: "failed", error: redact((e as Error).message, cfg) }).catch(() => undefined);
    }
  });
  return reel;
}

/** Resolves when every queued render has finished (used by the CLI and tests). */
export function waitForRenders(): Promise<unknown> {
  return chain;
}
