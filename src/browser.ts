import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Looks for an installed Chrome/Chromium/Edge, used when Remotion's own browser cannot be downloaded. */
export function findSystemBrowser(): string | null {
  const env = process.env;
  const fixed: string[] = [];
  if (process.platform === "darwin") {
    fixed.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    );
  } else if (process.platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[]) {
      fixed.push(
        join(base, "Google", "Chrome", "Application", "chrome.exe"),
        join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      );
    }
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) for (const n of names) fixed.push(join(dir, n));
  }
  for (const candidate of fixed) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}
