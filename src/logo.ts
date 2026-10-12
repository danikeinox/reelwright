import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDirs, getPaths } from "./config.js";

/**
 * The brand logo shown in every reel.
 *
 * Set only by the human (`reelwright logo <file>`), never by the AI: MCP tools do not accept
 * file paths. The file is copied into the Reelwright home, so the original can move freely.
 * Raster formats only (PNG, WebP, JPEG): SVG can carry scripts and external references.
 */

export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

const FORMATS = [
  { ext: "png", mime: "image/png", test: (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", mime: "image/webp", test: (b: Buffer) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  { ext: "jpg", mime: "image/jpeg", test: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
] as const;

export type LogoExt = (typeof FORMATS)[number]["ext"];

export interface LogoInfo {
  file: string;
  ext: LogoExt;
  mime: string;
  bytes: number;
}

/** Detects the image type from its first bytes (the file name is not trusted). */
export function sniffImage(head: Buffer): (typeof FORMATS)[number] | null {
  return FORMATS.find((f) => f.test(head)) ?? null;
}

function storedLogos(): string[] {
  const { home } = getPaths();
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((n) => /^logo\.(png|webp|jpg)$/.test(n));
}

export function getLogo(): LogoInfo | null {
  for (const name of storedLogos()) {
    const file = join(getPaths().home, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > LOGO_MAX_BYTES) continue;
      const fmt = sniffImage(readFileSync(file).subarray(0, 16));
      if (fmt) return { file, ext: fmt.ext, mime: fmt.mime, bytes: st.size };
    } catch {
      /* unreadable: ignore */
    }
  }
  return null;
}

export function removeLogo(): boolean {
  const names = storedLogos();
  for (const n of names) rmSync(join(getPaths().home, n), { force: true });
  return names.length > 0;
}

/** Validates and copies a logo into the Reelwright home, replacing any previous one. */
export function setLogo(source: string): LogoInfo {
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`File not found: ${src}`);
  const st = statSync(src);
  if (!st.isFile()) throw new Error("The logo must be a file, not a folder");
  if (st.size > LOGO_MAX_BYTES) throw new Error(`The logo is too big (max ${LOGO_MAX_BYTES / 1024 / 1024} MB)`);
  const fmt = sniffImage(readFileSync(src).subarray(0, 16));
  if (!fmt) throw new Error("Use a PNG, WebP or JPEG image (ideally with a transparent background)");
  const { home } = ensureDirs();
  removeLogo();
  const dest = join(home, `logo.${fmt.ext}`);
  copyFileSync(src, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    /* not supported on every filesystem */
  }
  return { file: dest, ext: fmt.ext, mime: fmt.mime, bytes: st.size };
}
