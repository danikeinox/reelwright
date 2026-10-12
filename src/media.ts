import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDirs, getPaths } from "./config.js";
import { sniffImage } from "./logo.js";

/**
 * Screenshots and background music the human adds for rich reels.
 *
 * Like the logo, these are added only by the human (`reelwright media add`, `reelwright music`).
 * The AI refers to screenshots by NAME (a short slug), never by path, and can only pick from
 * what the human already put in the library.
 */

export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
export const MEDIA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface MediaItem {
  name: string;
  file: string;
  ext: string;
  bytes: number;
}

function mediaDir(): string {
  return join(getPaths().home, "media");
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function listMedia(): MediaItem[] {
  const dir = mediaDir();
  if (!existsSync(dir)) return [];
  const out: MediaItem[] = [];
  for (const n of readdirSync(dir).sort()) {
    const m = n.match(/^([a-z0-9][a-z0-9-]{0,39})\.(png|webp|jpg)$/);
    if (!m) continue;
    const file = join(dir, n);
    try {
      const st = statSync(file);
      if (st.isFile() && st.size <= MEDIA_MAX_BYTES) out.push({ name: m[1]!, file, ext: m[2]!, bytes: st.size });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export function getMedia(name: string): MediaItem | null {
  if (!MEDIA_NAME_RE.test(name)) return null;
  return listMedia().find((m) => m.name === name) ?? null;
}

export function addMedia(source: string, name?: string): MediaItem {
  const src = resolve(source);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`File not found: ${src}`);
  const size = statSync(src).size;
  if (size > MEDIA_MAX_BYTES) throw new Error(`The image is too big (max ${MEDIA_MAX_BYTES / 1024 / 1024} MB)`);
  const fmt = sniffImage(readFileSync(src).subarray(0, 16));
  if (!fmt) throw new Error("Use a PNG, WebP or JPEG screenshot");
  const slug = slugify(name ?? src.split(/[\\/]/).pop() ?? "");
  if (!MEDIA_NAME_RE.test(slug)) throw new Error("Give it a short name with letters, numbers and dashes, e.g. --name checkout");
  ensureDirs();
  mkdirSync(mediaDir(), { recursive: true, mode: 0o700 });
  removeMedia(slug);
  const file = join(mediaDir(), `${slug}.${fmt.ext}`);
  copyFileSync(src, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported everywhere */
  }
  return { name: slug, file, ext: fmt.ext, bytes: size };
}

export function removeMedia(name: string): boolean {
  if (!MEDIA_NAME_RE.test(name) || !existsSync(mediaDir())) return false;
  let removed = false;
  for (const ext of ["png", "webp", "jpg"]) {
    const f = join(mediaDir(), `${name}.${ext}`);
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed = true;
    }
  }
  return removed;
}

// ---------- background music ----------

const AUDIO = [
  { ext: "wav", test: (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE" },
  { ext: "mp3", test: (b: Buffer) => b.length > 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) },
  { ext: "m4a", test: (b: Buffer) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp" },
] as const;

export function sniffAudio(head: Buffer): string | null {
  return AUDIO.find((a) => a.test(head))?.ext ?? null;
}

export interface MusicInfo {
  file: string;
  ext: string;
  bytes: number;
}

function storedMusic(): string[] {
  const { home } = getPaths();
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => /^music\.(wav|mp3|m4a)$/.test(n));
}

export function getMusic(): MusicInfo | null {
  for (const n of storedMusic()) {
    const file = join(getPaths().home, n);
    try {
      const st = statSync(file);
      if (st.isFile() && st.size <= MUSIC_MAX_BYTES && sniffAudio(readFileSync(file).subarray(0, 16))) {
        return { file, ext: n.split(".").pop()!, bytes: st.size };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function removeMusic(): boolean {
  const names = storedMusic();
  for (const n of names) rmSync(join(getPaths().home, n), { force: true });
  return names.length > 0;
}

export function setMusic(source: string): MusicInfo {
  const src = resolve(source);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`File not found: ${src}`);
  const size = statSync(src).size;
  if (size > MUSIC_MAX_BYTES) throw new Error(`The audio file is too big (max ${MUSIC_MAX_BYTES / 1024 / 1024} MB)`);
  const ext = sniffAudio(readFileSync(src).subarray(0, 16));
  if (!ext) throw new Error("Use a WAV, MP3 or M4A audio file");
  const { home } = ensureDirs();
  removeMusic();
  const file = join(home, `music.${ext}`);
  copyFileSync(src, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported everywhere */
  }
  return { file, ext, bytes: size };
}
