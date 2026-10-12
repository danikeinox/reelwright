import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { getPaths } from "../config.js";
import { serveSingleFile } from "./file-server.js";
import type { StagedMedia } from "./index.js";

const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";

/** Finds cloudflared in ~/.reelwright/bin first, then on PATH. */
export function findCloudflared(): string | null {
  const candidates = [join(getPaths().bin, exe), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, exe))];
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export function parseTunnelUrl(text: string): string | null {
  return TUNNEL_URL.exec(text)?.[0] ?? null;
}

export interface TunnelOptions {
  /** TESTS: use another executable than the real cloudflared. */
  binary?: string;
  startTimeoutMs?: number;
  readinessAttempts?: number;
  /** TESTS: skip waiting for the public hostname to resolve. */
  skipReadinessCheck?: boolean;
}

/** Opens a temporary public URL to one file via a Cloudflare quick tunnel (no account, no storage, no cost). */
export async function stageViaTunnel(file: string, opts: TunnelOptions = {}): Promise<StagedMedia> {
  const bin = opts.binary ?? findCloudflared();
  if (!bin) {
    throw new Error(
      "cloudflared is not installed. Run `reelwright setup` (it can install it for you) or choose S3/R2 storage.",
    );
  }
  const server = await serveSingleFile(file);
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${server.port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const cleanup = async () => {
    if (child.exitCode === null) child.kill();
    await server.close();
  };

  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the Cloudflare tunnel (check your network).")), opts.startTimeoutMs ?? 45_000);
      const onData = (chunk: Buffer) => {
        const m = TUNNEL_URL.exec(chunk.toString());
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not start cloudflared: ${e.message}`));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited early (code ${code})`));
      });
    });
    const url = `${base}${server.path}`;

    // Wait until the edge actually serves the file (new hostnames take a few seconds to resolve).
    const attempts = opts.readinessAttempts ?? 30;
    let ready = opts.skipReadinessCheck === true;
    for (let i = 0; i < attempts && !ready; i++) {
      try {
        const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        ready = res.ok;
      } catch {
        /* not resolvable yet */
      }
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) throw new Error("The tunnel started but never became reachable.");
    return { url, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
