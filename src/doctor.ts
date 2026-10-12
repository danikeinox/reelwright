import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureDirs, getPaths, loadConfig, redact } from "./config.js";
import { getBrand } from "./brand.js";
import { InstagramClient } from "./instagram.js";
import { bundleExists } from "./render.js";
import { findCloudflared } from "./storage/tunnel.js";

const run = promisify(execFile);

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  canRender: boolean;
  canPublish: boolean;
  summary: string;
}

export interface DoctorOptions {
  /** also download the browser if missing and verify S3 end to end */
  deep?: boolean;
  skipNetwork?: boolean;
}

function nodeOk(): boolean {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 12);
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  add(
    nodeOk()
      ? { name: "Node.js", status: "ok", detail: `v${process.versions.node}` }
      : { name: "Node.js", status: "fail", detail: `v${process.versions.node}`, fix: "Install Node.js 22.12 or newer (24 LTS recommended): https://nodejs.org" },
  );

  let paths = getPaths();
  try {
    paths = ensureDirs();
    const probe = join(paths.home, ".write-test");
    writeFileSync(probe, "ok");
    rmSync(probe);
    add({ name: "Data folder", status: "ok", detail: paths.home });
  } catch (e) {
    add({ name: "Data folder", status: "fail", detail: (e as Error).message, fix: `Make ${paths.home} writable or set REELWRIGHT_HOME` });
  }

  let cfg: ReturnType<typeof loadConfig> | undefined;
  try {
    cfg = loadConfig();
    add({ name: "Configuration", status: "ok", detail: existsSync(paths.config) ? paths.config : "defaults (no config file yet)" });
  } catch (e) {
    add({ name: "Configuration", status: "fail", detail: (e as Error).message, fix: "Run `reelwright setup` to rewrite it" });
  }

  const bundleOk = bundleExists();
  add(
    bundleOk
      ? { name: "Video engine", status: "ok", detail: "Remotion bundle present" }
      : { name: "Video engine", status: "fail", detail: "Remotion bundle missing", fix: "Reinstall: npm i -g reelwright" },
  );

  // Browser
  let browserOk = false;
  if (cfg) {
    const exe = process.env.REELWRIGHT_BROWSER || cfg.render.browserExecutable;
    if (exe) {
      browserOk = existsSync(exe);
      add(
        browserOk
          ? { name: "Browser for rendering", status: "ok", detail: exe }
          : { name: "Browser for rendering", status: "fail", detail: `Not found: ${exe}`, fix: "Fix render.browserExecutable or run `reelwright setup`" },
      );
    } else {
      const cache = join(paths.runtime, "node_modules", ".remotion");
      browserOk = existsSync(cache) && readdirSync(cache).length > 0;
      if (!browserOk && opts.deep) {
        try {
          const { ensureRenderBrowser } = await import("./render.js");
          await ensureRenderBrowser(cfg);
          browserOk = true;
        } catch (e) {
          add({ name: "Browser for rendering", status: "fail", detail: (e as Error).message, fix: "Run `reelwright setup`; if downloads are blocked, point setup at an installed Chrome/Edge" });
        }
      }
      if (browserOk) add({ name: "Browser for rendering", status: "ok", detail: "Chrome Headless Shell downloaded" });
      else if (!checks.some((c) => c.name === "Browser for rendering"))
        add({ name: "Browser for rendering", status: "warn", detail: "Not downloaded yet (one-time ~100 MB download)", fix: "Run `reelwright setup` (or just render once: it downloads automatically)" });
    }
  }

  // Storage
  let storageOk = false;
  if (cfg) {
    if (cfg.storage.mode === "tunnel") {
      const bin = findCloudflared();
      if (bin) {
        try {
          const { stdout } = await run(bin, ["--version"], { timeout: 15_000 });
          storageOk = true;
          add({ name: "Storage (temporary tunnel)", status: "ok", detail: stdout.trim() });
        } catch (e) {
          add({ name: "Storage (temporary tunnel)", status: "fail", detail: `cloudflared does not run: ${(e as Error).message}`, fix: "Run `reelwright setup` to reinstall it" });
        }
      } else {
        add({ name: "Storage (temporary tunnel)", status: cfg.instagram.accessToken ? "fail" : "warn", detail: "cloudflared not found", fix: "Run `reelwright setup` (installs it with checksum verification) or switch to S3/R2" });
      }
    } else if (!cfg.storage.s3) {
      add({ name: "Storage (S3/R2)", status: "fail", detail: "No bucket configured", fix: "Run `reelwright setup`" });
    } else if (opts.deep && !opts.skipNetwork) {
      try {
        const { checkS3 } = await import("./storage/s3.js");
        add({ name: "Storage (S3/R2)", status: "ok", detail: await checkS3(cfg.storage.s3) });
        storageOk = true;
      } catch (e) {
        add({ name: "Storage (S3/R2)", status: "fail", detail: redact((e as Error).message, cfg), fix: "Check endpoint, bucket and keys (the key needs read+write+delete)" });
      }
    } else {
      storageOk = true;
      add({ name: "Storage (S3/R2)", status: "info", detail: `bucket ${cfg.storage.s3.bucket} configured (run doctor --deep to test it)` });
    }
  }

  // Instagram
  let igOk = false;
  if (cfg) {
    if (!cfg.instagram.accessToken) {
      add({ name: "Instagram", status: "warn", detail: "Not connected (you can still render reels)", fix: "Run `reelwright setup` to add your access token — see docs/instagram.md" });
    } else if (opts.skipNetwork) {
      igOk = !!cfg.instagram.userId;
      add({ name: "Instagram", status: "info", detail: "token configured (network check skipped)" });
    } else {
      try {
        const me = await new InstagramClient(cfg).me();
        igOk = !!cfg.instagram.userId;
        add({
          name: "Instagram",
          status: cfg.instagram.userId ? "ok" : "warn",
          detail: `connected as @${me.username ?? "?"}${me.account_type ? ` (${me.account_type})` : ""}`,
          ...(cfg.instagram.userId ? {} : { fix: `Set instagram.userId to ${me.user_id ?? me.id ?? "your numeric id"} (run setup)` }),
        });
      } catch (e) {
        add({ name: "Instagram", status: "fail", detail: redact((e as Error).message, cfg), fix: "Generate a new token (docs/instagram.md) and run `reelwright setup`" });
      }
    }
  }

  // Voice
  if (cfg) {
    if (!cfg.tts.enabled || !cfg.tts.baseUrl) {
      add({ name: "Voice-over", status: "info", detail: "Off (reels are rendered with on-screen text and no voice)" });
    } else if (opts.skipNetwork) {
      add({ name: "Voice-over", status: "info", detail: cfg.tts.baseUrl });
    } else {
      try {
        const res = await fetch(`${cfg.tts.baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(5000), redirect: "error" });
        add({ name: "Voice-over", status: res.ok ? "ok" : "warn", detail: `${cfg.tts.baseUrl} answered HTTP ${res.status}` });
      } catch {
        add({ name: "Voice-over", status: "warn", detail: `Cannot reach ${cfg.tts.baseUrl}`, fix: "Start your local TTS (e.g. VoiceStudio) or disable voice-over" });
      }
    }
  }

  const brand = getBrand();
  add(
    brand
      ? { name: "Brand", status: "ok", detail: `${brand.name} (${brand.sourceUrl})` }
      : { name: "Brand", status: "info", detail: "Not set yet — ask Claude to run brand_init with your website URL" },
  );

  const canRender = bundleOk && nodeOk() && (browserOk || !!cfg);
  const canPublish = !!cfg && igOk && storageOk && canRender;
  const failures = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const summary = failures
    ? `${failures} problem(s) to fix before publishing`
    : canPublish
      ? "Everything is ready: you can render and publish"
      : warnings
        ? "Ready to render; finish the warnings to publish"
        : "Ready";
  return { checks, canRender, canPublish, summary };
}

export function formatReport(r: DoctorReport): string {
  const icon = { ok: "✔", warn: "!", fail: "✘", info: "·" } as const;
  const lines = r.checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}${c.fix ? `\n    → ${c.fix}` : ""}`);
  return `${lines.join("\n")}\n\n${r.summary}`;
}
