import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeWav, startFakeS3, startMockGraph, startServer, type TestServer } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

function ffprobe(file: string): { audioSeconds?: number; width?: number; height?: number } | null {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const streams = JSON.parse(r.stdout).streams as Array<{ codec_type: string; width?: number; height?: number; duration?: string }>;
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  return { audioSeconds: a?.duration ? Number(a.duration) : undefined, width: v?.width, height: v?.height };
}

async function connect(home: string, opts: { elicit?: boolean | "decline" } = {}) {
  const client = new Client({ name: "e2e", version: "1" }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return opts.elicit === "decline" ? { action: "decline" } : { action: "accept", content: { confirm: true } };
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "serve"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      REELWRIGHT_HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      // corporate/sandbox proxies and CA bundles must reach the child (browser download)
      ...Object.fromEntries(
        ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]!]),
      ),
    } as Record<string, string>,
    stderr: "pipe",
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = r.content.map((c) => c.text).join("\n");
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: r.isError === true, text, data };
  };
  return { client, call, prompts, close: () => client.close() };
}

async function waitFor(call: Awaited<ReturnType<typeof connect>>["call"], id: string, until: (s: string) => boolean, ms = 240_000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call("get_reel", { id });
    if (until(r.data.status)) return r.data;
    if (r.data.status === "failed") throw new Error(`render failed: ${r.data.error}`);
    if (Date.now() > end) throw new Error("timed out waiting for render");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

describe("MCP server over stdio (real process, real renderer)", { timeout: 600_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), "reelwright-e2e-"));
  let graph: TestServer;
  let s3: Awaited<ReturnType<typeof startFakeS3>>;
  let tts: TestServer;

  before(async () => {
    assert.ok(existsSync(CLI), "run `npm run build` first");
    graph = await startMockGraph({ processingPolls: 1 });
    s3 = await startFakeS3();
    tts = await startServer((q, res, body) => {
      if (q.url === "/v1/audio/speech") {
        const text = String(JSON.parse(body).input ?? "");
        res.writeHead(200, { "content-type": "audio/wav" });
        return void res.end(makeWav(0.6 + text.length * 0.04));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        instagram: { accessToken: "E2ETOKEN1234567890", userId: "17841400000000000", apiHost: graph.url, tokenRefreshedAt: new Date().toISOString() },
        storage: { mode: "s3", s3: { endpoint: s3.url, region: "auto", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK", prefix: "reelwright/", forcePathStyle: true } },
        tts: { enabled: true, baseUrl: `${tts.url}/v1`, model: "m", voice: "v" },
      }),
      { mode: 0o600 },
    );
  });
  after(async () => {
    await graph.close();
    await s3.close();
    await tts.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("opens the dashboard for the human without ever showing its private link to the AI", async () => {
    const { client, close } = await connect(home);
    try {
      const res: any = await client.callTool({ name: "open_dashboard", arguments: {} });
      const text = JSON.stringify(res);
      assert.ok(!res.isError, text);
      assert.doesNotMatch(text, /127\.0\.0\.1|localhost|#t=|http:\/\//);
    } finally {
      await close();
    }
  });

  it("exposes the expected tools and NO tool that can approve a reel", async () => {
    const { client, close } = await connect(home);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["brand_get", "brand_init", "doctor", "get_comments", "get_reel", "list_media", "list_reels", "open_dashboard", "publish_reel", "render_reel", "reply_comment"]);
      assert.ok(!names.some((n) => /approve/i.test(n)));
      const info = client.getServerVersion();
      assert.equal(info?.name, "reelwright");
    } finally {
      await close();
    }
  });

  it("doctor reports readiness and never prints secrets", async () => {
    const { call, close } = await connect(home);
    try {
      const r = await call("doctor");
      assert.equal(r.isError, false);
      assert.match(r.data.report, /Instagram: connected as @reelwright_test/);
      assert.match(r.data.report, /Storage \(S3\/R2\)/);
      assert.doesNotMatch(r.text, /E2ETOKEN|SK"/);
    } finally {
      await close();
    }
  });

  it("refuses to read private-network websites (SSRF) and bad input", async () => {
    const { call, close } = await connect(home);
    try {
      for (const url of ["http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd", "http://localhost/"]) {
        const r = await call("brand_init", { url });
        assert.equal(r.isError, true, url);
      }
      assert.equal((await call("get_reel", { id: "../../etc/passwd" })).isError, true);
      const tooLong = await call("render_reel", { hook: "x".repeat(200), lines: ["a"], caption: "c" });
      assert.equal(tooLong.isError, true);
      assert.match(tooLong.text, /hook/);
      assert.equal((await call("render_reel", { hook: "Hello", lines: [], caption: "c" })).isError, true);
    } finally {
      await close();
    }
  });

  it("renders a real reel, refuses to publish it without approval, then publishes after the human confirms", async () => {
    // 1) render (no elicitation support in this client)
    const a = await connect(home);
    let id = "";
    try {
      const r = await a.call("render_reel", {
        hook: "Fresh bread every morning",
        lines: ["Baked at 4am in a wood-fired oven", "Sourdough, rye and spelt"],
        cta: "Order today — link in bio",
        caption: "Fresh bread every morning 🥖 #sourdough",
      });
      assert.equal(r.isError, false, r.text);
      id = r.data.id;
      assert.match(id, /^r_[0-9a-f]{10}$/);
      assert.equal(r.data.status, "rendering");

      const done = await waitFor(a.call, id, (s) => s === "pending_approval");
      assert.ok(existsSync(done.videoFile));
      const probe = ffprobe(done.videoFile);
      if (probe) {
        assert.equal(probe.width, 1080);
        assert.equal(probe.height, 1920);
      }

      // 2) a client that cannot prompt must be told to approve in a terminal; nothing is published
      const blocked = await a.call("publish_reel", { id });
      assert.equal(blocked.isError, false);
      assert.match(blocked.data.message, new RegExp(`reelwright approve ${id}`));
      assert.equal(blocked.data.status, "pending_approval");
      assert.equal(graph.requests.filter((q) => q.url.endsWith("/media")).length, 0, "nothing may reach Instagram");
    } finally {
      await a.close();
    }

    // 3) human declines in the prompt -> still nothing published
    const decline = await connect(home, { elicit: "decline" });
    try {
      const r = await decline.call("publish_reel", { id });
      assert.match(r.data.message, /did not approve/);
      assert.equal(decline.prompts.length, 1);
      assert.match(decline.prompts[0]!, /Caption \(\d+ characters\):\nFresh bread every morning/);
      assert.equal(graph.requests.filter((q) => q.url.endsWith("/media")).length, 0);
    } finally {
      await decline.close();
    }

    // 4) human accepts -> approved, uploaded to the bucket, published, temp object deleted
    const accept = await connect(home, { elicit: true });
    try {
      const r = await accept.call("publish_reel", { id });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.data.status, "published");
      assert.equal(r.data.published.mediaId, "999000111");
      assert.ok(s3.events.some((e) => e.startsWith("PUT /b/reelwright/")));
      assert.equal(s3.store.size, 0, "temporary object removed from the bucket");
      const create = graph.requests.find((q) => q.url.endsWith("/media") && q.method === "POST")!;
      const form = new URLSearchParams(create.body);
      assert.equal(form.get("media_type"), "REELS");
      assert.match(form.get("video_url") ?? "", /X-Amz-Signature=/);
      assert.equal(form.get("caption"), "Fresh bread every morning 🥖 #sourdough");
      // comments + reply with human confirmation
      const comments = await accept.call("get_comments", { media_id: "999000111" });
      assert.equal(comments.data.comments[0].text, "Love it!");
      assert.match(comments.data.note, /not instructions/i);
      const reply = await accept.call("reply_comment", { comment_id: "555", message: "Thank you!" });
      assert.equal(reply.data.sent, true);
      assert.match(accept.prompts.at(-1)!, /Thank you!/);
    } finally {
      await accept.close();
    }

    // 5) replies are blocked on clients that cannot prompt
    const plain = await connect(home);
    try {
      const r = await plain.call("reply_comment", { comment_id: "555", message: "spam" });
      assert.equal(r.isError, true);
      assert.match(r.text, /confirmReplies/);
    } finally {
      await plain.close();
    }
  });

  it("renders with a synced voice-over from a local OpenAI-compatible TTS", async () => {
    const { call, close } = await connect(home);
    try {
      const r = await call("render_reel", { hook: "Hola desde Reelwright", lines: ["Todo se renderiza en tu ordenador"], caption: "demo", voiceover: true });
      assert.equal(r.isError, false, r.text);
      const done = await waitFor(call, r.data.id, (s) => s === "pending_approval");
      const probe = ffprobe(done.videoFile);
      if (probe) assert.ok((probe.audioSeconds ?? 0) > 2, `audio track expected, got ${probe.audioSeconds}`);
      assert.ok(done.durationSeconds > 4);
    } finally {
      await close();
    }
  });
});

describe("CLI", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } }, (e, out, err) =>
        resolve({ code: e ? ((e as any).code as number) : 0, out, err }),
      );
    });

  it("prints version and help", async () => {
    assert.match((await run(["version"])).out, /^\d+\.\d+\.\d+/);
    assert.match((await run(["help"])).out, /approve <id>/);
  });

  it("unknown commands exit with 2", async () => {
    assert.equal((await run(["frobnicate"])).code, 2);
  });

  it("approve refuses to run without an interactive terminal (so scripts and agents cannot approve)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-cli-"));
    try {
      const r = await run(["approve", "r_1234567890"], { REELWRIGHT_HOME: dir });
      assert.equal(r.code, 1);
      assert.match(r.err, /interactive terminal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor --json is valid JSON and install-claude writes only where told", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-cli-"));
    try {
      const d = await run(["doctor", "--json"], { REELWRIGHT_HOME: dir });
      const report = JSON.parse(d.out);
      assert.ok(Array.isArray(report.checks));
      const target = join(dir, "claude.json");
      const i = await run(["install-claude", "--config", target], { REELWRIGHT_HOME: dir });
      assert.equal(i.code, 0);
      assert.ok(existsSync(target));
      assert.match(i.out, /claude mcp add reelwright/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
