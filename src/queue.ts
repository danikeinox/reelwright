import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { ensureDirs, getPaths, writeSecureJson } from "./config.js";

export type ReelStatus =
  | "rendering"
  | "pending_approval"
  | "approved"
  | "publishing"
  /** Instagram did not confirm whether the post went live: a human must check the profile. */
  | "publish_unknown"
  | "published"
  | "rejected"
  | "failed";

export interface Reel {
  id: string;
  createdAt: string;
  status: ReelStatus;
  hook: string;
  lines: string[];
  cta?: string;
  caption: string;
  /** File name inside the reels directory (never a path chosen by a caller). */
  file?: string;
  durationSeconds?: number;
  voiceover: boolean;
  /** 0..1 while rendering */
  progress?: number;
  /** PID of the Reelwright process working on this reel (stale-job detection across processes). */
  ownerPid?: number;
  /** Set right before the irreversible media_publish call is sent. */
  publishSentAt?: string;
  /** Approval is bound to the exact bytes and caption the human saw. */
  approval?: { at: string; sha256: string; captionSha256: string; via: "cli" | "elicitation" | "ui" };
  publish?: { at: string; mediaId: string; permalink?: string };
  error?: string;
}

interface QueueFile {
  version: 1;
  reels: Reel[];
}

const ID_RE = /^r_[a-f0-9]{10}$/;

export function isValidReelId(id: string): boolean {
  return ID_RE.test(id);
}

export function newReelId(): string {
  return "r_" + randomBytes(5).toString("hex");
}

function load(): QueueFile {
  const file = getPaths().queue;
  if (!existsSync(file)) return { version: 1, reels: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as QueueFile;
    if (data?.version === 1 && Array.isArray(data.reels)) return data;
  } catch {
    /* fall through */
  }
  throw new Error(`Queue file ${file} is corrupted. Move it aside and retry (your videos are in ${getPaths().reels}).`);
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process lock: several MCP clients may each spawn their own Reelwright server. */
async function acquireFileLock(): Promise<() => void> {
  ensureDirs();
  const lock = `${getPaths().queue}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const owner = Number(readFileSync(lock, "utf8"));
      const age = Date.now() - statSync(lock).mtimeMs;
      if (age > LOCK_STALE_MS || (owner && !isProcessAlive(owner))) {
        unlinkSync(lock); // stale: its owner is gone
        continue;
      }
    } catch {
      continue; // vanished between checks
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Timed out waiting for the Reelwright queue lock (another Reelwright process is busy).");
    await sleep(20 + Math.random() * 40);
  }
}

// In-process chain + cross-process file lock keep every read-modify-write sequence atomic.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const release = await acquireFileLock();
    try {
      return await fn();
    } finally {
      release();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

export function listReels(status?: ReelStatus): Reel[] {
  const all = load().reels;
  return (status ? all.filter((r) => r.status === status) : all).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getReel(id: string): Reel | undefined {
  if (!isValidReelId(id)) return undefined;
  return load().reels.find((r) => r.id === id);
}

export function addReel(reel: Reel): Promise<Reel> {
  return locked(() => {
    ensureDirs();
    const q = load();
    q.reels.push(reel);
    writeSecureJson(getPaths().queue, q);
    return reel;
  });
}

export function updateReel(id: string, patch: Partial<Reel> | ((r: Reel) => Partial<Reel>)): Promise<Reel> {
  return locked(() => {
    const q = load();
    const i = q.reels.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`Unknown reel ${id}`);
    const current = q.reels[i]!;
    const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    q.reels[i] = next;
    writeSecureJson(getPaths().queue, q);
    return next;
  });
}

/** Called at startup: a render that was interrupted by a restart can never finish. */
export function failStaleRenders(): Promise<void> {
  return locked(() => {
    const q = load();
    let changed = false;
    for (const r of q.reels) {
      if ((r.status === "rendering" || r.status === "publishing") && !isProcessAlive(r.ownerPid)) {
        if (r.status === "rendering") {
          r.status = "failed";
          r.error = "Interrupted (Reelwright was restarted). Render again.";
        } else if (r.publishSentAt) {
          r.status = "publish_unknown";
          r.error = "Reelwright stopped while Instagram was publishing. Check your Instagram profile before trying again.";
        } else {
          r.status = "approved";
          r.error = "Interrupted before anything was sent to Instagram. Safe to retry publishing.";
        }
        changed = true;
      }
    }
    if (changed) writeSecureJson(getPaths().queue, q);
  });
}

/** Resolves a reel's video inside the reels directory, refusing anything that escapes it. */
export function reelFilePath(reel: Reel): string {
  if (!reel.file) throw new Error(`Reel ${reel.id} has no video file yet`);
  const dir = resolve(getPaths().reels);
  const full = resolve(join(dir, basename(reel.file)));
  if (!full.startsWith(dir + sep)) throw new Error("Refusing path outside the reels directory");
  return full;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What a human is shown when reviewing: the hashes the approval will be bound to. */
export async function reviewSnapshot(reel: Reel): Promise<{ sha256: string; captionSha256: string }> {
  return { sha256: await sha256File(reelFilePath(reel)), captionSha256: sha256Text(reel.caption) };
}

/**
 * Marks a reel approved. `expected` is REQUIRED: it is what the human actually looked at, and approval is
 * refused if the video or caption is anything else by the time it is recorded (checked under the queue lock).
 */
export async function approveReel(
  id: string,
  via: "cli" | "elicitation" | "ui",
  expected: { sha256: string; captionSha256: string },
): Promise<Reel> {
  const reel = getReel(id);
  if (!reel) throw new Error(`Unknown reel ${id}`);
  if (!["pending_approval", "approved", "publish_unknown"].includes(reel.status)) throw new Error(`Reel ${id} is ${reel.status}; only rendered reels can be approved`);
  const sha256 = await sha256File(reelFilePath(reel));
  const stale = "The video or caption changed since you looked at it. Review it again.";
  if (expected.sha256 !== sha256) throw new Error(stale);
  return updateReel(id, (r) => {
    if (!["pending_approval", "approved", "publish_unknown"].includes(r.status)) throw new Error(`Reel ${id} is ${r.status}; only rendered reels can be approved`);
    if (expected.captionSha256 !== sha256Text(r.caption)) throw new Error(stale);
    return { status: "approved", error: undefined, approval: { at: new Date().toISOString(), sha256, captionSha256: expected.captionSha256, via } };
  });
}

/** Throws unless the reel is approved AND the video and caption are exactly what was approved. */
export async function assertPublishable(reel: Reel): Promise<void> {
  if (reel.status !== "approved" || !reel.approval) throw new Error(`Reel ${reel.id} is not approved`);
  const sha = await sha256File(reelFilePath(reel));
  if (sha !== reel.approval.sha256) throw new Error("The video changed after approval. Approve it again.");
  if (sha256Text(reel.caption) !== reel.approval.captionSha256) throw new Error("The caption changed after approval. Approve it again.");
}

/** Atomically moves an approved reel to "publishing"; fails if another process already claimed it. */
export function claimForPublishing(id: string): Promise<Reel> {
  return updateReel(id, (r) => {
    if (r.status !== "approved") throw new Error(`Reel ${id} is ${r.status}, not approved (maybe another Reelwright process is publishing it)`);
    return { status: "publishing", ownerPid: process.pid, publishSentAt: undefined, error: undefined };
  });
}

/** Edits the caption of a rendered reel. Any earlier approval is void, so it goes back to review. */
export function setReelCaption(id: string, caption: string): Promise<Reel> {
  return updateReel(id, (r) => {
    if (!["pending_approval", "approved", "publish_unknown", "failed"].includes(r.status) || !r.file) {
      throw new Error(`Reel ${id} is ${r.status}; its caption cannot be edited now`);
    }
    return { caption, status: "pending_approval", approval: undefined, error: undefined };
  });
}
