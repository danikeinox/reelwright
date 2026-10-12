import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { registerCleanup } from "./cleanup.js";
import { getPaths, loadConfig, redact, type Config } from "./config.js";
import { InstagramClient, InstagramError } from "./instagram.js";
import { claimForPublishing, getReel, reelFilePath, sha256Text, updateReel, type Reel } from "./queue.js";
import { stageMedia, type StagedMedia } from "./storage/index.js";
import { maybeRefreshToken } from "./token.js";

export interface PublishDeps {
  stage?: (cfg: Config, file: string, id: string) => Promise<StagedMedia>;
  pollIntervalMs?: number;
  skipTokenRefresh?: boolean;
}

const inflight = new Set<string>();

/** Copies the video to a private staging file while hashing it, so what is verified is what is uploaded. */
async function stageHashedCopy(src: string, id: string): Promise<{ copy: string; sha256: string }> {
  const dir = join(getPaths().tmp, `publish-${id}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const copy = join(dir, "reel.mp4");
  const hash = createHash("sha256");
  const input = createReadStream(src);
  input.on("data", (c) => hash.update(c));
  await pipeline(input, createWriteStream(copy, { mode: 0o600 }));
  return { copy, sha256: hash.digest("hex") };
}

/**
 * Publishes an APPROVED reel. The approval must be bound to the exact video bytes and caption
 * (see queue.approveReel); anything else is refused. Never accepts a path or a caption from callers.
 */
export async function publishApprovedReel(id: string, deps: PublishDeps = {}): Promise<Reel> {
  if (inflight.has(id)) throw new Error(`Reel ${id} is already being published`);
  inflight.add(id);
  let claimed = false;
  let sent = false;
  let staged: StagedMedia | undefined;
  let unregister: (() => void) | undefined;
  let workDir: string | undefined;
  const cfg0 = loadConfig();
  try {
    const initial = getReel(id);
    if (!initial) throw new Error(`Unknown reel ${id}`);
    if (initial.status !== "approved" || !initial.approval) throw new Error(`Reel ${id} is not approved`);
    if (sha256Text(initial.caption) !== initial.approval.captionSha256) throw new Error("The caption changed after approval. Approve it again.");

    if (!deps.skipTokenRefresh) await maybeRefreshToken();
    const cfg = loadConfig();
    const ig = new InstagramClient(cfg);

    // Atomic across processes: only one Reelwright process can move approved -> publishing.
    await claimForPublishing(id);
    claimed = true;

    const copied = await stageHashedCopy(reelFilePath(initial), id);
    workDir = join(getPaths().tmp, `publish-${id}`);
    if (copied.sha256 !== initial.approval.sha256) throw new Error("The video changed after approval. Approve it again.");

    staged = await (deps.stage ?? stageMedia)(cfg, copied.copy, id);
    unregister = registerCleanup(() => staged!.cleanup());
    const container = await ig.createReelContainer(staged.url, initial.caption);
    await ig.waitUntilReady(container, { intervalMs: deps.pollIntervalMs });

    // Point of no return: record that the irreversible call is about to leave this computer.
    await updateReel(id, { publishSentAt: new Date().toISOString() });
    sent = true;
    const { mediaId, permalink } = await ig.publish(container);
    return await updateReel(id, {
      status: "published",
      publish: { at: new Date().toISOString(), mediaId, permalink },
      error: undefined,
    });
  } catch (e) {
    if (claimed) {
      // An answer with an API error code means Instagram refused: safe to retry. Anything else after the
      // publish call was sent (timeout, dropped connection) is ambiguous: the post may be live.
      const ambiguous = sent && !(e instanceof InstagramError && e.code !== undefined);
      const msg = redact((e as Error).message, cfg0);
      await updateReel(id, ambiguous
        ? { status: "publish_unknown", error: `Instagram did not confirm the post (${msg}). Check your Instagram profile; if it is live, ignore this reel, otherwise approve and publish again.` }
        : { status: "approved", error: msg }).catch(() => undefined);
    }
    throw e;
  } finally {
    unregister?.();
    if (staged) await staged.cleanup().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    inflight.delete(id);
  }
}
