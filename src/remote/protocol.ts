/**
 * Wire protocol between the local Reelwright agent and the (optional, self-hosted) remote dashboard.
 * Uses only Web Crypto so the exact same code runs in Node and in Cloudflare Workers.
 *
 * Trust model: the dashboard can ask the agent to do a small allowlist of LOW-IMPACT things
 * (see Command). It can never approve or publish, and it never receives credentials.
 */
import { z } from "zod";

export const MAX_SKEW_MS = 60_000;
export const MAX_BODY_BYTES = 256 * 1024;

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

async function hmacKey(secret: string): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

/** Constant-time comparison of two hex strings via HMAC verify (no early exit on the first differing byte). */
export async function verifyHmacHex(secret: string, message: string, sigHex: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, enc.encode(message));
}

export function randomHex(bytes = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A shared secret has to be strong: at least 256 bits of randomness, hex or base64url. */
export function generateSecret(): string {
  return randomHex(32);
}

export function isStrongSecret(s: string | undefined): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

// ---------- request / response authentication ----------

export type SignedHeaders = {
  "x-rw-ts": string;
  "x-rw-nonce": string;
  "x-rw-sig": string;
};

function requestMessage(method: string, path: string, ts: string, nonce: string, bodyHash: string): string {
  return ["rw1", method.toUpperCase(), path, ts, nonce, bodyHash].join("\n");
}

export async function signRequest(secret: string, method: string, path: string, body: string, now = Date.now()): Promise<SignedHeaders> {
  const ts = String(now);
  const nonce = randomHex(16);
  const sig = await hmacHex(secret, requestMessage(method, path, ts, nonce, await sha256Hex(body)));
  return { "x-rw-ts": ts, "x-rw-nonce": nonce, "x-rw-sig": sig };
}

export type VerifyResult = { ok: true; nonce: string; ts: number } | { ok: false; reason: string };

/** Checks signature and freshness. The caller must still reject a nonce it has already seen. */
export async function verifyRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  headers: { get(name: string): string | null },
  now = Date.now(),
): Promise<VerifyResult> {
  const ts = headers.get("x-rw-ts") ?? "";
  const nonce = headers.get("x-rw-nonce") ?? "";
  const sig = headers.get("x-rw-sig") ?? "";
  if (!/^\d{13}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "malformed" };
  if (Math.abs(now - Number(ts)) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  const good = await verifyHmacHex(secret, requestMessage(method, path, ts, nonce, await sha256Hex(body)), sig);
  return good ? { ok: true, nonce, ts: Number(ts) } : { ok: false, reason: "bad signature" };
}

/** Responses are signed too, bound to the request nonce, so the agent only obeys the real dashboard. */
export async function signResponse(secret: string, requestNonce: string, body: string): Promise<string> {
  return hmacHex(secret, ["rw1-resp", requestNonce, await sha256Hex(body)].join("\n"));
}

export async function verifyResponse(secret: string, requestNonce: string, body: string, sigHex: string): Promise<boolean> {
  return verifyHmacHex(secret, ["rw1-resp", requestNonce, await sha256Hex(body)].join("\n"), sigHex);
}

// ---------- payloads ----------

/** Captions are public text. Refuse control/bidi characters and walls of blank lines that can hide content from a reviewer. */
export function isSafeCaption(c: string): boolean {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(c)) return false;
  if (/(\r?\n[ \t]*){4,}/.test(c)) return false;
  return c.trim().length > 0;
}

const hex6 = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const reelId = z.string().regex(/^r_[a-f0-9]{10}$/);

/**
 * The ONLY things the dashboard can ask for. Deliberately absent: approve, publish, any setting that
 * holds or points at a secret or an address (tokens, buckets, voice URL), file paths.
 */
export const CommandSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), type: z.literal("reject_reel"), reelId }).strict(),
  z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), type: z.literal("set_caption"), reelId, caption: z.string().min(1).max(2200).refine(isSafeCaption, "caption contains hidden or control characters") }).strict(),
  z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), type: z.literal("set_theme"), bg: hex6, fg: hex6, accent: hex6 }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;

/** What the agent reports. No paths, no secrets, bounded sizes. */
export const StateSchema = z
  .object({
    version: z.string().max(20),
    at: z.string().max(40),
    health: z.object({ summary: z.string().max(300), canRender: z.boolean(), canPublish: z.boolean() }).strict(),
    reels: z
      .array(
        z
          .object({
            id: reelId,
            status: z.enum(["rendering", "pending_approval", "approved", "publishing", "publish_unknown", "published", "rejected", "failed"]),
            createdAt: z.string().max(40),
            hook: z.string().max(200),
            caption: z.string().max(2200),
            durationSeconds: z.number().min(0).max(600).optional(),
            error: z.string().max(400).optional(),
            permalink: z.string().max(300).regex(/^https:\/\/(www\.)?instagram\.com\/[\w\-./?=&%]*$/).optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type AgentState = z.infer<typeof StateSchema>;

export const ResultSchema = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), ok: z.boolean(), error: z.string().max(300).optional() }).strict();

export const SyncRequestSchema = z.object({ state: StateSchema, results: z.array(ResultSchema).max(50).default([]) }).strict();
export const SyncResponseSchema = z.object({ commands: z.array(CommandSchema).max(20) }).strict();
