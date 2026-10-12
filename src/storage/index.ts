import type { Config } from "../config.js";

/** A temporary public URL for one video, plus a function that tears it down. */
export interface StagedMedia {
  url: string;
  cleanup: () => Promise<void>;
}

export async function stageMedia(cfg: Config, file: string, id: string): Promise<StagedMedia> {
  if (cfg.storage.mode === "s3") {
    if (!cfg.storage.s3) throw new Error("Storage mode is s3 but no bucket is configured (run `reelwright setup`).");
    const { stageViaS3 } = await import("./s3.js");
    return stageViaS3(cfg.storage.s3, file, id);
  }
  const { stageViaTunnel } = await import("./tunnel.js");
  return stageViaTunnel(file);
}
