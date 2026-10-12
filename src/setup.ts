import { ConfigSchema, ensureDirs, getPaths, readConfigFile, redact, saveConfigFile } from "./config.js";
import { findSystemBrowser } from "./browser.js";
import { formatReport, runDoctor } from "./doctor.js";
import { InstagramClient } from "./instagram.js";
import { claudeCodeCommand, installIntoClaudeDesktop } from "./install.js";
import { ask, confirm, isInteractive } from "./prompt.js";
import { ensureRenderBrowser } from "./render.js";
import { installCloudflared } from "./storage/cloudflared-install.js";
import { findCloudflared } from "./storage/tunnel.js";

const say = (m = "") => console.log(m);

export interface SetupOptions {
  yes?: boolean;
  skipBrowser?: boolean;
  skipInstall?: boolean;
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  const interactive = isInteractive() && !opts.yes;
  if (!interactive && !opts.yes) {
    throw new Error("`reelwright setup` needs a terminal. Run it in a terminal, or use `reelwright setup --yes` for the non-interactive defaults.");
  }
  ensureDirs();
  say("Reelwright setup — everything stays on this computer.\n");

  let file = readConfigFile();
  const save = () => {
    saveConfigFile(file);
  };

  // 1) rendering browser
  if (!opts.skipBrowser) {
    say("1/5  Video engine");
    const cfg = ConfigSchema.parse(file);
    try {
      say("     Preparing the rendering browser (first time downloads about 100 MB)…");
      const kind = await ensureRenderBrowser(cfg);
      say(`     OK (${kind}).`);
    } catch (e) {
      say(`     Could not download the browser: ${(e as Error).message}`);
      const sys = findSystemBrowser();
      if (sys && (opts.yes || (await confirm(`     Use the browser installed at ${sys}?`, true)))) {
        file.render = { ...(file.render ?? {}), browserExecutable: sys };
        save();
        say("     Using your installed browser.");
      } else if (interactive) {
        const p = await ask("     Path to Chrome/Chromium/Edge (empty to skip)");
        if (p) {
          file.render = { ...(file.render ?? {}), browserExecutable: p };
          save();
        }
      }
    }
  }

  // 2) storage
  say("\n2/5  Where Instagram fetches your video from");
  say("     Instagram needs a public https link to the video for a few seconds while it imports it.");
  let mode = (file.storage?.mode as string | undefined) ?? "tunnel";
  if (interactive) {
    const choice = await ask("     Use a temporary Cloudflare tunnel (free, nothing is stored) or your own S3/R2 bucket? (tunnel/s3)", { def: mode });
    mode = choice.toLowerCase().startsWith("s") ? "s3" : "tunnel";
  }
  if (mode === "tunnel") {
    file.storage = { ...(file.storage ?? {}), mode: "tunnel" };
    if (!findCloudflared()) {
      if (opts.yes || (await confirm("     cloudflared is not installed. Download the official build (checksum verified)?", true))) {
        try {
          await installCloudflared((m) => say(`     ${m}`));
        } catch (e) {
          say(`     Could not install cloudflared automatically: ${(e as Error).message}`);
          say("     Install it yourself (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or re-run setup and choose s3.");
        }
      }
    } else say("     cloudflared found.");
  } else {
    const prev = file.storage?.s3 ?? {};
    const endpoint = await ask("     S3 endpoint URL (R2: https://<account>.r2.cloudflarestorage.com; AWS: empty)", { def: prev.endpoint ?? "" });
    const region = await ask("     Region (R2: auto)", { def: prev.region ?? "auto" });
    const bucket = await ask("     Bucket name", { def: prev.bucket ?? "" });
    const accessKeyId = await ask("     Access key id", { def: prev.accessKeyId ?? "" });
    const secretAccessKey = await ask("     Secret access key (hidden)", { secret: true, def: prev.secretAccessKey ?? "" });
    file.storage = {
      ...(file.storage ?? {}),
      mode: "s3",
      s3: { ...prev, ...(endpoint ? { endpoint } : {}), region, bucket, accessKeyId, secretAccessKey, forcePathStyle: Boolean(endpoint) },
    };
    try {
      save();
      const { checkS3 } = await import("./storage/s3.js");
      say(`     ${await checkS3(ConfigSchema.parse(file).storage.s3!)}`);
    } catch (e) {
      say(`     Bucket test failed: ${redact((e as Error).message)}`);
    }
  }
  save();

  // 3) Instagram
  say("\n3/5  Instagram");
  if (interactive) {
    const have = file.instagram?.accessToken ? " (a token is already saved; press Enter to keep it)" : "";
    say("     You need an Instagram Business/Creator account and a token from your own Meta app: see docs/instagram.md");
    const token = await ask(`     Access token${have} (hidden, empty to skip)`, { secret: true });
    if (token) {
      try {
        const probe = ConfigSchema.parse({ ...file, instagram: { ...(file.instagram ?? {}), accessToken: token } });
        const me = await new InstagramClient(probe).me();
        const userId = String(me.user_id ?? me.id ?? "");
        if (!/^\d+$/.test(userId)) throw new Error("Instagram did not return your numeric user id");
        file.instagram = { ...(file.instagram ?? {}), accessToken: token, userId, tokenRefreshedAt: new Date().toISOString() };
        save();
        say(`     Connected as @${me.username ?? "?"}${me.account_type ? ` (${me.account_type})` : ""}.`);
      } catch (e) {
        say(`     Could not verify the token: ${redact((e as Error).message, ConfigSchema.parse(file))}`);
        say("     Nothing was saved for Instagram. You can retry any time with `reelwright setup`.");
      }
    }
  } else say("     Skipped (non-interactive). Set REELWRIGHT_IG_TOKEN and REELWRIGHT_IG_USER_ID or run setup in a terminal.");

  // 4) voice
  say("\n4/5  Voice-over (optional)");
  if (interactive) {
    const url = await ask("     Base URL of your local OpenAI-compatible TTS, e.g. http://127.0.0.1:8000/v1 (empty = no voice)", {
      def: file.tts?.baseUrl ?? "",
    });
    if (url) {
      const model = await ask("     Model name", { def: file.tts?.model ?? "voicestudio" });
      const voice = await ask("     Voice / cloned-voice profile name", { def: file.tts?.voice ?? "default" });
      file.tts = { ...(file.tts ?? {}), enabled: true, baseUrl: url, model, voice };
    } else file.tts = { ...(file.tts ?? {}), enabled: false };
    save();
  } else say("     Skipped.");

  // 5) Claude
  say("\n5/5  Connect to Claude");
  if (!opts.skipInstall) {
    if (opts.yes || (await confirm("     Add Reelwright to Claude Desktop now?", true))) {
      try {
        const r = installIntoClaudeDesktop();
        say(r.changed ? `     Added to ${r.configPath}${r.backupPath ? ` (backup: ${r.backupPath})` : ""}. Restart Claude Desktop.` : "     Already configured.");
      } catch (e) {
        say(`     ${(e as Error).message}`);
      }
    }
    say("     For Claude Code run:\n       " + claudeCodeCommand());
  }

  say("\nChecking everything…\n");
  say(formatReport(await runDoctor()));
  say(`\nYour data lives in ${getPaths().home}`);
}
