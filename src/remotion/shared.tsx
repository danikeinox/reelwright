import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

export const FONT = '"Inter Variable", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function useInterFont(): void {
  const [handle] = useState(() => delayRender("Loading Inter"));
  useEffect(() => {
    Promise.all([document.fonts.load('800 80px "Inter Variable"'), document.fonts.load('600 80px "Inter Variable"')])
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [handle]);
}

/**
 * Logo files often sit in a big transparent square. Crop the transparent margin in the browser
 * (canvas, same-origin file from the bundle) so the visible mark gets the space it is given.
 */
export function useTrimmedLogo(logoFile?: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const [handle] = useState(() => (logoFile ? delayRender("Loading logo") : null));
  useEffect(() => {
    if (!logoFile || handle === null) return;
    const url = staticFile(logoFile);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3]! > 16) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) {
          setSrc(url);
        } else {
          const out = document.createElement("canvas");
          out.width = x1 - x0 + 1;
          out.height = y1 - y0 + 1;
          out.getContext("2d")!.drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
          setSrc(out.toDataURL("image/png"));
        }
      } catch {
        setSrc(url);
      }
      continueRender(handle);
    };
    img.onerror = () => {
      setSrc(null);
      continueRender(handle);
    };
    img.src = url;
  }, [logoFile, handle]);
  return src;
}

