import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, readConfigFile, redact, saveConfigFile, writeSecureJson, getPaths, type Config } from "../config.js";
import { runDoctor } from "../doctor.js";
import { getReel, listReels, setReelCaption, updateReel } from "../queue.js";
import { packageVersion } from "../version.js";
import {
  CommandSchema, MAX_BODY_BYTES, StateSchema, SyncResponseSchema, isStrongSecret, signRequest, verifyResponse,
  type AgentState, type Command,
} from "./protocol.js";

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("The dashboard's answer is too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

const SYNC_PATH = "/agent/sync";
const SEEN_FILE = () => join(getPaths().home, "remote-seen.json");

/** Errors travel to the cloud: strip anything that looks like a path or a URL (presigned links, local folders). */
export function scrubError(text: string): string {
  return redact(text)
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[\w.@ -]+[\\/])+[\w.@ -]*/g, "[path]")
    .slice(0, 300);
}

export async function buildState(): Promise<AgentState> {
  const report = await runDoctor({ skipNetwork: true });
  const reels = listReels().slice(0, 100).map((r) => ({
    id: r.id,
    status: r.status,
    createdAt: r.createdAt,
    hook: r.hook.slice(0, 200),
    caption: r.caption.slice(0, 2200),
    ...(r.durationSeconds !== undefined ? { durationSeconds: r.durationSeconds } : {}),
    ...(r.error ? { error: scrubError(r.error) } : {}),
    ...(r.publish?.permalink && /^https:\/\/(www\.)?instagram\.com\//.test(r.publish.permalink) ? { permalink: r.publish.permalink } : {}),
  }));
  return StateSchema.parse({
    version: packageVersion(),
    at: new Date().toISOString(),
    health: { summary: report.summary.slice(0, 300), canRender: report.canRender, canPublish: report.canPublish },
    reels,
  });
}

function loadSeen(): string[] {
  try {
    return existsSync(SEEN_FILE()) ? (JSON.parse(readFileSync(SEEN_FILE(), "utf8")) as string[]) : [];
  } catch {
    return [];
  }
}

/** Executes one validated command. Idempotent per command id. */
export async function executeCommand(cmd: Command): Promise<void> {
  switch (cmd.type) {
    case "reject_reel": {
      const r = getReel(cmd.reelId);
      if (!r) throw new Error("Unknown reel");
      if (!["pending_approval", "approved", "publish_unknown", "failed"].includes(r.status)) throw new Error(`Reel is ${r.status}`);
      await updateReel(cmd.reelId, { status: "rejected", approval: undefined });
      return;
    }
    case "set_caption":
      await setReelCaption(cmd.reelId, cmd.caption); // voids any approval: a human must approve the new text locally
      return;
    case "set_theme": {
      const file = readConfigFile();
      file.defaultTheme = { bg: cmd.bg, fg: cmd.fg, accent: cmd.accent };
      saveConfigFile(file);
      return;
    }
  }
}

export interface SyncOutcome {
  executed: number;
  online: boolean;
}

let pendingResults: Array<{ id: string; ok: boolean; error?: string }> = [];

/** One round trip: report state and results, receive and run commands. Throws only on transport/auth problems. */
export async function syncOnce(cfg: Config = loadConfig(), fetchImpl: typeof fetch = fetch): Promise<SyncOutcome> {
  const { url, secret } = cfg.remote;
  if (!url || !isStrongSecret(secret)) throw new Error("Remote dashboard is not configured. Run `reelwright remote init`.");
  const body = JSON.stringify({ state: await buildState(), results: pendingResults.slice(0, 50) });
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("State too large to sync");
  const headers = await signRequest(secret, "POST", SYNC_PATH, body);
  const res = await fetchImpl(new URL(SYNC_PATH, url), {
    method: "POST",
    redirect: "error", // never follow a redirect with signed material
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new Error("The dashboard's answer is too large");
  const text = await readCapped(res, MAX_BODY_BYTES);
  if (!res.ok) throw new Error(`Dashboard answered HTTP ${res.status}`);
  if (!(await verifyResponse(secret, headers["x-rw-nonce"], text, res.headers.get("x-rw-sig") ?? ""))) {
    throw new Error("The dashboard's answer was not signed with your secret. Ignoring it.");
  }
  pendingResults = pendingResults.slice(50);
  const { commands } = SyncResponseSchema.parse(JSON.parse(text));
  const seen = loadSeen();
  let executed = 0;
  for (const raw of commands) {
    const cmd = CommandSchema.parse(raw);
    if (seen.includes(cmd.id)) {
      pendingResults.push({ id: cmd.id, ok: true });
      continue;
    }
    try {
      await executeCommand(cmd);
      pendingResults.push({ id: cmd.id, ok: true });
    } catch (e) {
      pendingResults.push({ id: cmd.id, ok: false, error: scrubError((e as Error).message) });
    }
    seen.push(cmd.id);
    executed++;
  }
  if (executed) writeSecureJson(SEEN_FILE(), seen.slice(-300));
  return { executed, online: true };
}

/** Background loop; backs off when the dashboard is unreachable. Returns a stop function. */
export function startRemoteLoop(log: (m: string) => void, intervalMs = 15_000): () => void {
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const cfg = loadConfig();
      if (cfg.remote.url && cfg.remote.secret) {
        const r = await syncOnce(cfg);
        if (r.executed) log(`remote: ran ${r.executed} command(s)`);
        failures = 0;
      }
    } catch (e) {
      if (failures++ === 0) log(`remote: ${redact((e as Error).message)}`);
    }
    if (!stopped) timer = setTimeout(tick, Math.min(intervalMs * 2 ** Math.min(failures, 5), 5 * 60_000));
    timer?.unref();
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
