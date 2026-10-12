import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetchBrand, getBrand, initBrand } from "../brand.js";
import { loadConfig, readConfigFile, redact, saveConfigFile } from "../config.js";
import { runDoctor } from "../doctor.js";
import { InstagramClient } from "../instagram.js";
import { publishApprovedReel } from "../publish.js";
import { approveReel, getReel, isValidReelId, listReels, reelFilePath, setReelCaption, sha256File, sha256Text, updateReel, type Reel } from "../queue.js";
import { synthesize } from "../tts.js";
import { isSafeCaption } from "../remote/protocol.js";

/**
 * Local management panel. Threat model: the browser the user opens is trusted; every other web page,
 * local process-less attacker and AI client is not.
 *
 *  - listens on 127.0.0.1 only, random port
 *  - API needs a random bearer token that lives in the URL *fragment* (never sent to servers or logs)
 *  - custom Authorization header => cross-origin pages cannot call the API (CORS preflight is never granted)
 *  - Host and Origin are validated (DNS rebinding / CSRF)
 *  - strict CSP, no inline scripts, no third-party resources
 *  - secrets can be written but are never sent back to the browser
 */

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 64 * 1024;

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export interface UiHandle {
  /** Full URL including the secret fragment. For tests; never pass it in a process argument. */
  url: string;
  /** A single-use link (valid 30 s) that redirects to the panel. Safe to hand to the OS to open: it is worthless once used. */
  openUrl: () => string;
  port: number;
  close: () => Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(c as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** What the browser may see: no secret ever leaves this function. */
export function publicConfig() {
  const c = loadConfig();
  return {
    instagram: {
      connected: Boolean(c.instagram.accessToken && c.instagram.userId),
      hasToken: Boolean(c.instagram.accessToken),
      userId: c.instagram.userId ?? "",
      apiVersion: c.instagram.apiVersion,
      tokenRefreshedAt: c.instagram.tokenRefreshedAt ?? null,
    },
    storage: {
      mode: c.storage.mode,
      s3: c.storage.s3
        ? {
            endpoint: c.storage.s3.endpoint ?? "",
            region: c.storage.s3.region,
            bucket: c.storage.s3.bucket,
            prefix: c.storage.s3.prefix,
            hasKeys: Boolean(c.storage.s3.accessKeyId && c.storage.s3.secretAccessKey),
          }
        : null,
    },
    tts: { enabled: c.tts.enabled, baseUrl: c.tts.baseUrl ?? "", model: c.tts.model, voice: c.tts.voice, hasApiKey: Boolean(c.tts.apiKey) },
    safety: { confirmReplies: c.safety.confirmReplies },
    remote: { configured: Boolean(c.remote.url && c.remote.secret), url: c.remote.url ?? "" },
    defaultTheme: c.defaultTheme ?? null,
  };
}

const str = (max: number) => z.string().max(max);
const ConfigPatch = z
  .object({
    instagram: z.object({ accessToken: str(1000).optional(), userId: str(30).optional() }).strict().optional(),
    storage: z
      .object({
        mode: z.enum(["tunnel", "s3"]).optional(),
        s3: z
          .object({
            endpoint: str(300).optional(),
            region: str(60).optional(),
            bucket: str(120).optional(),
            prefix: str(200).optional(),
            accessKeyId: str(300).optional(),
            secretAccessKey: str(600).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({ enabled: z.boolean().optional(), baseUrl: str(300).optional(), model: str(80).optional(), voice: str(80).optional(), apiKey: str(600).optional() })
      .strict()
      .optional(),
    safety: z.object({ confirmReplies: z.boolean().optional() }).strict().optional(),
    defaultTheme: z.object({ bg: str(7), fg: str(7), accent: str(7) }).strict().nullable().optional(),
  })
  .strict();

/** Merges a validated patch into config.json. Empty strings mean "leave unchanged" for secrets, "clear" otherwise. */
export function applyConfigPatch(patchRaw: unknown): void {
  const patch = ConfigPatch.parse(patchRaw);
  const file = readConfigFile();
  const setIf = (obj: Record<string, any>, key: string, value: string | undefined, secret: boolean) => {
    if (value === undefined) return;
    if (value === "") {
      if (!secret) delete obj[key];
      return; // an empty secret never erases the stored one
    }
    obj[key] = value.trim();
  };
  if (patch.instagram) {
    file.instagram ??= {};
    setIf(file.instagram, "accessToken", patch.instagram.accessToken, true);
    setIf(file.instagram, "userId", patch.instagram.userId, false);
    if (patch.instagram.accessToken) file.instagram.tokenRefreshedAt = new Date().toISOString();
  }
  if (patch.storage) {
    file.storage ??= {};
    if (patch.storage.mode) file.storage.mode = patch.storage.mode;
    if (patch.storage.s3) {
      const s = (file.storage.s3 ??= {});
      const beforeEndpoint = s.endpoint;
      setIf(s, "endpoint", patch.storage.s3.endpoint, false);
      if (s.endpoint !== beforeEndpoint && !(patch.storage.s3.accessKeyId && patch.storage.s3.secretAccessKey)) {
        throw new Error("When you change the endpoint, enter the access key and secret again.");
      }
      setIf(s, "region", patch.storage.s3.region, false);
      setIf(s, "bucket", patch.storage.s3.bucket, false);
      setIf(s, "prefix", patch.storage.s3.prefix, false);
      setIf(s, "accessKeyId", patch.storage.s3.accessKeyId, true);
      setIf(s, "secretAccessKey", patch.storage.s3.secretAccessKey, true);
      s.forcePathStyle = Boolean(s.endpoint);
    }
  }
  if (patch.tts) {
    file.tts ??= {};
    if (patch.tts.enabled !== undefined) file.tts.enabled = patch.tts.enabled;
    const before = file.tts.baseUrl;
    setIf(file.tts, "baseUrl", patch.tts.baseUrl, false);
    // Repointing the voice server must not carry the old key to the new address.
    if (file.tts.baseUrl !== before && !patch.tts.apiKey) delete file.tts.apiKey;
    setIf(file.tts, "model", patch.tts.model, false);
    setIf(file.tts, "voice", patch.tts.voice, false);
    setIf(file.tts, "apiKey", patch.tts.apiKey, true);
  }
  if (patch.safety?.confirmReplies !== undefined) (file.safety ??= {}).confirmReplies = patch.safety.confirmReplies;
  if (patch.defaultTheme === null) delete file.defaultTheme;
  else if (patch.defaultTheme) file.defaultTheme = patch.defaultTheme;
  saveConfigFile(file); // validates the whole result before anything is written
}

function describe(r: Reel) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    status: r.status,
    hook: r.hook,
    lines: r.lines,
    cta: r.cta,
    caption: r.caption,
    durationSeconds: r.durationSeconds,
    voiceover: r.voiceover,
    progress: r.progress,
    hasVideo: Boolean(r.file),
    approval: r.approval ? { at: r.approval.at, via: r.approval.via } : null,
    publish: r.publish ?? null,
    error: r.error,
  };
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function startUi(opts: { port?: number } = {}): Promise<UiHandle> {
  const token = randomBytes(32).toString("base64url");
  let port = 0;

  const openNonces = new Map<string, number>();
  const hostOk = (h: string | undefined) => !!h && (h === `127.0.0.1:${port}` || h === `localhost:${port}`);

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding & cross-site defence come first, for every request.
      if (!hostOk(req.headers.host)) throw new HttpError(403, "Bad host");
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new HttpError(403, "Bad origin");

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      const once = path.match(/^\/o\/([\w-]{20,})$/);
      if (once && method === "GET") {
        const exp = openNonces.get(once[1]!);
        openNonces.delete(once[1]!); // single use, whatever happens
        if (!exp || exp < Date.now()) throw new HttpError(404, "Not found");
        res.writeHead(302, { ...SECURITY_HEADERS, location: `/#t=${token}` });
        return res.end();
      }

      if (!path.startsWith("/api/")) {
        const asset = ASSETS[path];
        if (!asset || (method !== "GET" && method !== "HEAD")) throw new HttpError(404, "Not found");
        const content = readFileSync(join(PUBLIC_DIR, asset.file)); // read first: a failure must not leave a half-sent response
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": asset.type });
        return res.end(method === "HEAD" ? undefined : content);
      }

      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token)) {
        await new Promise((r) => setTimeout(r, 300)); // slow down guessing
        throw new HttpError(401, "Unauthorized");
      }

      const m = (re: RegExp) => path.match(re);
      let hit: RegExpMatchArray | null;

      if (method === "GET" && path === "/api/status") {
        const report = await runDoctor({ skipNetwork: true });
        return sendJson(res, 200, { report, version: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version });
      }
      if (method === "GET" && path === "/api/config") return sendJson(res, 200, publicConfig());
      if (method === "PUT" && path === "/api/config") {
        try {
          applyConfigPatch(await readJson(req));
        } catch (e) {
          if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, redact((e as Error).message));
        }
        return sendJson(res, 200, publicConfig());
      }
      if (method === "POST" && path === "/api/test/instagram") {
        const me = await new InstagramClient(loadConfig()).me();
        return sendJson(res, 200, { ok: true, username: me.username ?? null, accountType: me.account_type ?? null });
      }
      if (method === "POST" && path === "/api/test/storage") {
        const cfg = loadConfig();
        if (cfg.storage.mode === "s3") {
          if (!cfg.storage.s3) throw new HttpError(400, "Fill in the bucket first");
          const { checkS3 } = await import("../storage/s3.js");
          return sendJson(res, 200, { ok: true, message: await checkS3(cfg.storage.s3) });
        }
        const { findCloudflared } = await import("../storage/tunnel.js");
        const found = await findCloudflared();
        return sendJson(res, 200, { ok: Boolean(found), message: found ? "cloudflared found." : "cloudflared is not installed. Run `reelwright setup` or choose S3/R2." });
      }
      if (method === "POST" && path === "/api/test/voice") {
        const { info } = await synthesize(loadConfig(), "Hello from Reelwright.");
        return sendJson(res, 200, { ok: true, message: `Voice works (${info.seconds.toFixed(1)} s of audio).` });
      }

      if (method === "GET" && path === "/api/brand") return sendJson(res, 200, { brand: getBrand() });
      if (method === "POST" && path === "/api/brand") {
        const { url: site } = z.object({ url: z.string().url().max(500) }).parse(await readJson(req));
        return sendJson(res, 200, { brand: await initBrand(site) });
      }
      if (method === "POST" && path === "/api/brand/preview") {
        const { url: site } = z.object({ url: z.string().url().max(500) }).parse(await readJson(req));
        return sendJson(res, 200, { brand: await fetchBrand(site) });
      }

      if (method === "GET" && path === "/api/reels") return sendJson(res, 200, { reels: listReels().map(describe) });

      if ((hit = m(/^\/api\/reels\/(r_[a-f0-9]{10})(\/[a-z]+)?$/))) {
        const id = hit[1]!;
        const action = hit[2] ?? "";
        if (!isValidReelId(id)) throw new HttpError(404, "Unknown reel");
        const reel = getReel(id);
        if (!reel) throw new HttpError(404, "Unknown reel");

        if (method === "GET" && action === "") {
          const out: Record<string, unknown> = { ...describe(reel) };
          if (reel.file) {
            out.sha256 = await sha256File(reelFilePath(reel));
            out.captionSha256 = sha256Text(reel.caption);
          }
          return sendJson(res, 200, out);
        }
        if (method === "GET" && action === "/video") {
          const file = reelFilePath(reel);
          const size = statSync(file).size;
          res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "video/mp4", "content-length": size });
          createReadStream(file).on("error", () => res.destroy()).pipe(res);
          return;
        }
        if (method === "POST" && action === "/approve") {
          const body = z.object({ sha256: z.string().length(64), captionSha256: z.string().length(64) }).parse(await readJson(req));
          const r = await approveReel(id, "ui", body);
          return sendJson(res, 200, describe(r));
        }
        if (method === "POST" && action === "/reject") {
          await readJson(req);
          if (!["pending_approval", "approved", "publish_unknown", "failed"].includes(reel.status)) throw new HttpError(409, `Reel is ${reel.status}`);
          return sendJson(res, 200, describe(await updateReel(id, { status: "rejected", approval: undefined })));
        }
        if (method === "PUT" && action === "/caption") {
          const { caption } = z.object({ caption: z.string().min(1).max(2200).refine(isSafeCaption, "The caption has hidden/control characters or too many blank lines") }).parse(await readJson(req));
          return sendJson(res, 200, describe(await setReelCaption(id, caption)));
        }
        if (method === "POST" && action === "/publish") {
          await readJson(req);
          return sendJson(res, 200, describe(await publishApprovedReel(id)));
        }
      }
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      if (e instanceof z.ZodError) return sendJson(res, 400, { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      let msg = e instanceof Error ? e.message : String(e);
      try {
        msg = redact(msg, loadConfig());
      } catch {
        msg = redact(msg);
      }
      return sendJson(res, 500, { error: msg });
    }
  });

  server.requestTimeout = 5 * 60_000 + 30_000; // publishing can take minutes
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#t=${token}`,
    openUrl: () => {
      for (const [n, exp] of openNonces) if (exp < Date.now()) openNonces.delete(n);
      const nonce = randomBytes(24).toString("base64url");
      openNonces.set(nonce, Date.now() + 30_000);
      return `http://127.0.0.1:${port}/o/${nonce}`;
    },
    port,
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}
