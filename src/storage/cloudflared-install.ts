import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureDirs } from "../config.js";

const run = promisify(execFile);

function assetName(): { name: string; tgz: boolean } {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) throw new Error(`Unsupported CPU architecture: ${process.arch}`);
  switch (process.platform) {
    case "linux":
      return { name: `cloudflared-linux-${arch}`, tgz: false };
    case "darwin":
      return { name: `cloudflared-darwin-${arch}.tgz`, tgz: true };
    case "win32":
      return { name: `cloudflared-windows-${arch}.exe`, tgz: false };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/**
 * Downloads the official cloudflared release into ~/.reelwright/bin and verifies the SHA-256
 * digest published by GitHub for that exact asset before it is ever executed.
 */
export async function installCloudflared(log: (m: string) => void = () => {}): Promise<string> {
  const { name, tgz } = assetName();
  const { bin } = ensureDirs();
  log("Looking up the latest official cloudflared release…");
  const rel = await fetch("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "reelwright" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!rel.ok) {
    throw new Error(
      `GitHub API answered HTTP ${rel.status} (rate limit or blocked network). Install cloudflared yourself ` +
        "(brew install cloudflared · winget install Cloudflare.cloudflared · https://pkg.cloudflare.com for Linux) " +
        "or use your own S3/R2 bucket instead.",
    );
  }
  const meta: any = await rel.json();
  const asset = (meta.assets ?? []).find((a: any) => a.name === name);
  if (!asset) throw new Error(`Release ${meta.tag_name} has no asset ${name}`);
  const digest = String(asset.digest ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("GitHub did not publish a SHA-256 digest for this asset; refusing to install it automatically.");
  }
  if (!String(asset.browser_download_url).startsWith("https://github.com/cloudflare/cloudflared/releases/download/")) {
    throw new Error("Unexpected download URL; refusing.");
  }
  log(`Downloading ${name} (${meta.tag_name}, ${(asset.size / 1e6).toFixed(0)} MB)…`);
  const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (`sha256:${got}` !== digest) throw new Error("Checksum mismatch: the download was corrupted or tampered with. Nothing was installed.");

  const target = join(bin, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  mkdirSync(bin, { recursive: true });
  if (tgz) {
    const tmp = join(bin, "cloudflared.tgz");
    writeFileSync(tmp, buf);
    await run("tar", ["-xzf", tmp, "-C", bin, "cloudflared"]);
    rmSync(tmp, { force: true });
  } else {
    const tmp = `${target}.download`;
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
  }
  if (process.platform !== "win32") chmodSync(target, 0o755);
  const { stdout } = await run(target, ["--version"], { timeout: 15_000 });
  log(`Installed ${stdout.trim()} (checksum verified).`);
  return target;
}
