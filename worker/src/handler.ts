import {
  CommandSchema,
  MAX_BODY_BYTES,
  StateSchema,
  SyncRequestSchema,
  isStrongSecret,
  randomHex,
  signResponse,
  verifyRequest,
  type Command,
} from "../../src/remote/protocol.js";
import { verifyAccessJwt } from "./access.js";
import type { Store } from "./store.js";
import { APP_JS, INDEX_HTML, STYLE_CSS } from "./ui.js";

export interface Env {
  /** Hex secret (64 chars) shared with the local agent. Set with `wrangler secret put AGENT_SECRET`. */
  AGENT_SECRET?: string;
  /** e.g. myteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag */
  ACCESS_AUD?: string;
  /** Optional extra check: only this email may use the dashboard (Access policy should already enforce it). */
  ALLOWED_EMAIL?: string;
}

export interface Deps {
  now?: number;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; json(): Promise<any> }>;
}

const COMMAND_TTL_MS = 24 * 3600_000;
const MAX_PENDING = 25;
const ONLINE_WINDOW_MS = 90_000;

const HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function json(status: number, data: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8", ...extra } });
}
const deny = (status = 401) => json(status, { error: status === 401 ? "unauthorized" : "forbidden" });

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) (all.set(c, o), (o += c.length));
  return new TextDecoder().decode(all);
}

export async function handle(req: Request, env: Env, store: Store, deps: Deps = {}): Promise<Response> {
  const now = deps.now ?? Date.now();
  const url = new URL(req.url);
  const path = url.pathname;

  // ---------- agent channel: authenticated by HMAC, not by Access ----------
  if (path === "/agent/sync") {
    if (req.method !== "POST") return deny(404);
    if (!isStrongSecret(env.AGENT_SECRET)) return json(503, { error: "AGENT_SECRET is not configured" });
    const body = await readBody(req);
    if (body === null) return json(413, { error: "too large" });
    const v = await verifyRequest(env.AGENT_SECRET, "POST", path, body, req.headers, now);
    if (!v.ok) return deny(401); // same answer for every failure: nothing to learn
    if (!(await store.useNonce(v.nonce, now, 5 * 60_000))) return deny(401); // replay
    let parsed;
    try {
      parsed = SyncRequestSchema.parse(JSON.parse(body));
    } catch {
      return json(400, { error: "bad payload" });
    }
    await store.putState(JSON.stringify(parsed.state), now);
    for (const r of parsed.results) await store.recordResult(r.id, r.ok, r.error);
    const pending = await store.takePending(10, now);
    const commands: Command[] = [];
    for (const p of pending) {
      const c = CommandSchema.safeParse(JSON.parse(p.body));
      if (c.success) commands.push(c.data);
    }
    const out = JSON.stringify({ commands });
    return new Response(out, { status: 200, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8", "x-rw-sig": await signResponse(env.AGENT_SECRET, v.nonce, out) } });
  }

  // ---------- everything else: Cloudflare Access only ----------
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return json(503, { error: "Dashboard is locked until ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured (see worker/README.md)." });
  }
  const who = await verifyAccessJwt(req.headers.get("cf-access-jwt-assertion"), { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }, deps.fetchImpl, now);
  if (!who) return deny(401);
  if (env.ALLOWED_EMAIL && who.email?.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) return deny(403);

  const asset = (body: string, type: string) => new Response(body, { status: 200, headers: { ...HEADERS, "content-type": type } });
  if (req.method === "GET") {
    if (path === "/") return asset(INDEX_HTML, "text/html; charset=utf-8");
    if (path === "/app.js") return asset(APP_JS, "text/javascript; charset=utf-8");
    if (path === "/style.css") return asset(STYLE_CSS, "text/css; charset=utf-8");
    if (path === "/api/state") {
      const s = await store.getState();
      const recent = (await store.recent(15)).map((c) => ({ id: c.id, status: c.status, error: c.error, createdAt: c.createdAt, command: JSON.parse(c.body) }));
      return json(200, {
        online: s ? now - s.updatedAt < ONLINE_WINDOW_MS : false,
        lastSeen: s?.updatedAt ?? null,
        state: s ? StateSchema.parse(JSON.parse(s.json)) : null,
        commands: recent,
      });
    }
    return deny(404);
  }

  if (req.method === "POST" && path === "/api/commands") {
    // CSRF: Access cookies are ambient credentials, so require a header a cross-site form cannot send,
    // a same-origin Origin, and (when present) Sec-Fetch-Site.
    if (req.headers.get("x-requested-with") !== "reelwright") return deny(403);
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return deny(403);
    const sfs = req.headers.get("sec-fetch-site");
    if (sfs && sfs !== "same-origin") return deny(403);
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return json(415, { error: "send JSON" });
    const body = await readBody(req);
    if (body === null) return json(413, { error: "too large" });

    let cmd: Command;
    try {
      cmd = CommandSchema.parse({ ...JSON.parse(body), id: randomHex(16) });
    } catch {
      return json(400, { error: "That command is not allowed." });
    }
    // Reels must exist in the latest reported state and be in a state the command makes sense for.
    if (cmd.type !== "set_theme") {
      const s = await store.getState();
      const reel = s ? StateSchema.parse(JSON.parse(s.json)).reels.find((r) => r.id === cmd.reelId) : undefined;
      if (!reel) return json(404, { error: "Unknown reel" });
      if (!["pending_approval", "approved", "publish_unknown", "failed"].includes(reel.status)) return json(409, { error: `Reel is ${reel.status}` });
    }
    if ((await store.countPending(now)) >= MAX_PENDING) return json(429, { error: "Too many pending commands. Is your computer online?" });
    await store.addCommand({ id: cmd.id, body: JSON.stringify(cmd), status: "pending", createdAt: now, expiresAt: now + COMMAND_TTL_MS });
    return json(202, { queued: cmd.id });
  }
  return deny(404);
}
