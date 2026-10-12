import { loadConfig, readConfigFile, saveConfigFile } from "./config.js";
import { InstagramClient } from "./instagram.js";

const REFRESH_AFTER_MS = 20 * 24 * 3600 * 1000;

/**
 * Instagram long-lived tokens expire after 60 days unless refreshed. Refreshing at startup
 * (at most every 20 days) means you never have to touch the token again as long as you use Reelwright.
 * Tokens supplied through environment variables are managed by you and never rewritten.
 */
export async function maybeRefreshToken(log: (m: string) => void = () => {}): Promise<boolean> {
  if (process.env.REELWRIGHT_IG_TOKEN) return false;
  const cfg = loadConfig();
  if (!cfg.instagram.accessToken) return false;
  const last = cfg.instagram.tokenRefreshedAt ? Date.parse(cfg.instagram.tokenRefreshedAt) : 0;
  if (last && Date.now() - last < REFRESH_AFTER_MS) return false;
  try {
    const { token } = await new InstagramClient(cfg).refreshToken();
    const file = readConfigFile();
    file.instagram = { ...(file.instagram ?? {}), accessToken: token, tokenRefreshedAt: new Date().toISOString() };
    saveConfigFile(file);
    log("Instagram token refreshed (valid for another 60 days).");
    return true;
  } catch (e) {
    // Typical early on: a token younger than 24h cannot be refreshed yet. Not fatal.
    log(`Instagram token not refreshed: ${(e as Error).message}`);
    return false;
  }
}
