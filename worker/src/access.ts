/**
 * Verifies the JWT that Cloudflare Access attaches to every authenticated request
 * (header Cf-Access-Jwt-Assertion). We never trust the mere presence of the header: signature,
 * issuer, audience and expiry are all checked, so a request that reaches the Worker around Access
 * (e.g. via another route) is still rejected.
 */
export interface AccessConfig {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's AUD tag */
  aud: string;
}

type Fetch = (url: string) => Promise<{ ok: boolean; json(): Promise<any> }>;

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const parseJson = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

let jwksCache: { at: number; team: string; keys: any[] } | null = null;

async function getKeys(cfg: AccessConfig, fetchImpl: Fetch, now: number, force = false): Promise<any[]> {
  if (!force && jwksCache && jwksCache.team === cfg.teamDomain && now - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetchImpl(`https://${cfg.teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Cannot load Access keys");
  const keys = (await res.json()).keys as any[];
  jwksCache = { at: now, team: cfg.teamDomain, keys };
  return keys;
}

export function resetAccessCache(): void {
  jwksCache = null;
}

export async function verifyAccessJwt(
  token: string | null,
  cfg: AccessConfig,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  now = Date.now(),
): Promise<{ email?: string; sub?: string } | null> {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = parseJson(b64urlToBytes(parts[0]!));
    const payload = parseJson(b64urlToBytes(parts[1]!));
    if (header.alg !== "RS256") return null; // never accept "none" or HMAC downgrades
    const verifyWith = async (keys: any[]) => {
      const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
      if (!jwk) return false;
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    };
    let keys = await getKeys(cfg, fetchImpl, now);
    // Refresh only when the key id is unknown (key rotation), and at most once a minute: a forged token
    // must not be able to make this Worker call out on every request.
    if (!keys.some((k) => k.kid === header.kid) && jwksCache && now - jwksCache.at > 60_000) keys = await getKeys(cfg, fetchImpl, now, true);
    const valid = await verifyWith(keys);
    if (!valid) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (payload.iss !== `https://${cfg.teamDomain}`) return null;
    const sec = Math.floor(now / 1000);
    if (typeof payload.exp !== "number" || payload.exp < sec) return null;
    if (typeof payload.nbf === "number" && payload.nbf > sec + 30) return null;
    return { email: payload.email, sub: payload.sub };
  } catch {
    return null;
  }
}
