import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "../src/config.js";
import { installCloudflared } from "../src/storage/cloudflared-install.js";
import { withTempHome } from "./helpers.js";

const arch = process.arch === "arm64" ? "arm64" : "amd64";
const NAME = `cloudflared-linux-${arch}`;
const BINARY = Buffer.from("#!/bin/sh\necho 'cloudflared version 2099.1.0 (stub)'\n");
const sha = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;

describe("cloudflared installer (stubbed GitHub)", () => {
  let home: ReturnType<typeof withTempHome>;
  const realFetch = globalThis.fetch;
  beforeEach(() => (home = withTempHome()));
  afterEach(() => {
    globalThis.fetch = realFetch;
    home.cleanup();
  });

  function stub(opts: { digest?: string; url?: string; body?: Buffer }) {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) {
        return new Response(
          JSON.stringify({
            tag_name: "2099.1.0",
            assets: [{ name: NAME, size: 40, digest: opts.digest, browser_download_url: opts.url ?? `https://github.com/cloudflare/cloudflared/releases/download/2099.1.0/${NAME}` }],
          }),
          { status: 200 },
        );
      }
      return new Response(opts.body ?? BINARY, { status: 200 });
    }) as typeof fetch;
  }

  it("installs a binary whose checksum matches the published digest", async (t) => {
    if (process.platform !== "linux") return t.skip("stub is a linux shell script");
    stub({ digest: sha(BINARY) });
    const msgs: string[] = [];
    const target = await installCloudflared((m) => msgs.push(m));
    assert.equal(target, join(getPaths().bin, "cloudflared"));
    assert.ok(statSync(target).mode & 0o100, "executable");
    assert.match(msgs.join("\n"), /checksum verified/);
  });

  it("refuses a download whose checksum does not match, and leaves nothing behind", async (t) => {
    if (process.platform !== "linux") return t.skip("linux only");
    stub({ digest: sha(Buffer.from("something else")) });
    await assert.rejects(installCloudflared(), /Checksum mismatch/);
    assert.equal(existsSync(join(getPaths().bin, "cloudflared")), false);
  });

  it("refuses when GitHub publishes no digest", async (t) => {
    if (process.platform !== "linux") return t.skip("linux only");
    stub({ digest: undefined });
    await assert.rejects(installCloudflared(), /did not publish a SHA-256 digest/);
  });

  it("refuses downloads from any other host", async (t) => {
    if (process.platform !== "linux") return t.skip("linux only");
    stub({ digest: sha(BINARY), url: `https://evil.example/${NAME}` });
    await assert.rejects(installCloudflared(), /Unexpected download URL/);
  });

  it("explains a blocked GitHub API", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await assert.rejects(installCloudflared(), /HTTP 403.*Install cloudflared yourself/);
  });
});
