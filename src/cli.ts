#!/usr/bin/env node
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatReport, runDoctor } from "./doctor.js";
import { claudeCodeCommand, claudeDesktopConfigPaths, installIntoClaudeDesktop } from "./install.js";
import { startRender, waitForRenders } from "./jobs.js";
import { confirm } from "./prompt.js";
import { approveReel, reviewSnapshot, getReel, isValidReelId, listReels, reelFilePath, updateReel } from "./queue.js";
import { createServer, packageVersion, startupTasks } from "./server.js";
import { loadConfig } from "./config.js";
import { maybeRefreshToken } from "./token.js";
import { runCleanups } from "./cleanup.js";
import { openExternal } from "./ui/open.js";
import { startRemoteLoop, syncOnce } from "./remote/agent.js";
import { generateSecret } from "./remote/protocol.js";
import { readConfigFile, saveConfigFile } from "./config.js";

const HELP = `Reelwright ${packageVersion()} — local-first Instagram Reels MCP server

Usage: reelwright <command>

  setup                 Guided setup (browser, storage, Instagram, voice, Claude)   [--yes for defaults]
  install-claude        Add Reelwright to Claude Desktop (--print to only show, --uninstall to remove)
  doctor                Check that everything works                                  [--deep] [--json]
  demo                  Render a sample reel to prove the engine works               [--voice]
  logo <file>           Use your logo (PNG, WebP or JPEG) in every reel             [--remove]
  media add <file>      Add a screenshot for phone scenes      [--name checkout]   · media list · media remove <name>
  music <file>          Background music for scene reels (WAV, MP3, M4A)            [--remove]
  list                  Show the reels in your queue
  approve <id>          Watch a rendered reel and approve it for publishing (human only)
  reject <id>           Reject a rendered reel
  ui                    Open the management panel in your browser (local only)       [--no-open]
  remote init|status    Optional remote dashboard on your own Cloudflare account (see worker/README.md)
  remote                Keep this computer connected to your remote dashboard
  refresh-token         Renew the Instagram token now
  serve                 Run the MCP server over stdio (what Claude launches)
  version               Print the version
`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function serve(): Promise<void> {
  // stdout is the protocol channel: anything else that writes to it (library progress bars,
  // stray console.log) would corrupt the stream, so route it to stderr and give the
  // transport the original stdout.
  const realWrite = process.stdout.write.bind(process.stdout) as (chunk: any, enc?: any, cb?: any) => boolean;
  process.stdout.write = ((chunk: any, enc?: any, cb?: any) => process.stderr.write(chunk, enc, cb)) as typeof process.stdout.write;
  const transportOut = new Writable({
    write(chunk, enc, cb) {
      realWrite(chunk, enc, cb);
    },
  });
  const log = (m: string) => process.stderr.write(`[reelwright] ${m}\n`);

  // A tool server must outlive a failing job: log to stderr (never stdout) and keep serving.
  process.on("unhandledRejection", (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));
  process.on("uncaughtException", (err) => log(`uncaught exception: ${err.message}`));

  const server = createServer();
  await server.connect(new StdioServerTransport(process.stdin, transportOut));
  log(`MCP server ${packageVersion()} ready`);
  void startupTasks(log);
  const stopRemote = startRemoteLoop(log);

  const bye = () => {
    stopRemote();
    void runCleanups().finally(() => process.exit(0));
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  process.stdin.on("end", bye);
}

const openFile = openExternal;

async function main(): Promise<void> {
  const [cmd = "", ...rest] = process.argv.slice(2);

  // `npx reelwright` launched by an MCP client (no TTY, no arguments) means "serve".
  if (cmd === "serve" || (cmd === "" && !process.stdin.isTTY)) return serve();

  switch (cmd) {
    case "":
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(packageVersion());
      return;

    case "setup": {
      const { runSetup } = await import("./setup.js");
      await runSetup({ yes: flag(rest, "--yes"), skipBrowser: flag(rest, "--skip-browser"), skipInstall: flag(rest, "--skip-install") });
      return;
    }

    case "install-claude": {
      if (flag(rest, "--print")) {
        console.log(`Claude Desktop config file(s):\n  ${claudeDesktopConfigPaths().join("\n  ")}\nClaude Code:\n  ${claudeCodeCommand()}`);
        return;
      }
      const cfgIdx = rest.indexOf("--config");
      const target = cfgIdx >= 0 ? rest[cfgIdx + 1] : undefined;
      const targets = target ? [target] : claudeDesktopConfigPaths();
      for (const t of targets) {
        const r = installIntoClaudeDesktop(t, flag(rest, "--uninstall"));
        console.log(
          r.changed
            ? `${flag(rest, "--uninstall") ? "Removed from" : "Added to"} ${r.configPath}${r.backupPath ? ` (backup: ${r.backupPath})` : ""}.`
            : `Nothing to change in ${r.configPath}.`,
        );
      }
      if (targets.length > 1) console.log("(Found the Microsoft Store version of Claude too: updated both config files.)");
      console.log("Restart Claude Desktop to load it (quit it from the system tray, not just the window).");
      console.log(`\nClaude Code:\n  ${claudeCodeCommand()}`);
      return;
    }

    case "doctor": {
      const report = await runDoctor({ deep: flag(rest, "--deep") });
      console.log(flag(rest, "--json") ? JSON.stringify(report, null, 2) : formatReport(report));
      process.exitCode = report.checks.some((c) => c.status === "fail") ? 1 : 0;
      return;
    }

    case "demo": {
      const voice = flag(rest, "--voice");
      console.log("Rendering a sample reel on this computer (first run downloads the browser, about 100 MB)…");
      const reel = await startRender({
        hook: "Your website, as a reel",
        lines: ["Rendered on your own computer", "No cloud, no subscription", "You approve before anything posts"],
        cta: "Try Reelwright",
        caption: "Made with Reelwright — local-first reels from your website.",
        voiceover: voice,
      });
      await waitForRenders();
      const done = getReel(reel.id)!;
      if (done.status === "failed") {
        console.error(`Render failed: ${done.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Done in ${done.durationSeconds}s of video: ${reelFilePath(done)}`);
      return;
    }

    case "logo": {
      const { getLogo, removeLogo, setLogo } = await import("./logo.js");
      if (flag(rest, "--remove")) {
        console.log(removeLogo() ? "Logo removed. Reels will show the brand name instead." : "There was no logo to remove.");
        return;
      }
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) {
        const cur = getLogo();
        console.log(cur ? `Current logo: ${cur.file}` : "No logo set. Usage: reelwright logo <file.png|webp|jpg>");
        return;
      }
      try {
        const info = setLogo(file);
        console.log(`Logo saved: ${info.file}\nIt will appear in every new reel (tip: a light logo with a transparent background suits the dark reels).`);
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }

    case "media": {
      const { addMedia, listMedia, removeMedia } = await import("./media.js");
      const [sub = "list", ...args] = rest;
      try {
        if (sub === "add") {
          const file = args.find((a) => !a.startsWith("--"));
          const ni = args.indexOf("--name");
          if (!file) throw new Error("Usage: reelwright media add <file> [--name short-name]");
          const m = addMedia(file, ni >= 0 ? args[ni + 1] : undefined);
          console.log(`Added "${m.name}". Claude can now use it in a phone scene.`);
        } else if (sub === "remove") {
          console.log(args[0] && removeMedia(args[0]) ? `Removed "${args[0]}".` : "Nothing removed.");
        } else {
          const items = listMedia();
          console.log(items.length ? items.map((m) => `${m.name.padEnd(24)} ${Math.round(m.bytes / 1024)} KB`).join("\n") : "No screenshots yet. Add one with: reelwright media add <file> --name <name>");
        }
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }

    case "music": {
      const { getMusic, removeMusic, setMusic } = await import("./media.js");
      if (flag(rest, "--remove")) {
        console.log(removeMusic() ? "Music removed." : "There was no music to remove.");
        return;
      }
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) {
        const cur = getMusic();
        console.log(cur ? `Current music: ${cur.file}` : "No music set. Usage: reelwright music <file.wav|mp3|m4a>");
        return;
      }
      try {
        const m = setMusic(file);
        console.log(`Music saved: ${m.file}\nOnly use music you have the rights to.`);
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }

    case "list": {
      const reels = listReels();
      if (!reels.length) console.log("No reels yet.");
      for (const r of reels) console.log(`${r.id}  ${r.status.padEnd(16)} ${r.createdAt.slice(0, 16)}  ${r.hook}`);
      return;
    }

    case "approve":
    case "reject": {
      const id = rest[0] ?? "";
      if (!isValidReelId(id)) throw new Error(`Usage: reelwright ${cmd} <reel id>   (see: reelwright list)`);
      // Approval is a human act: refuse when there is no interactive terminal (scripts, agents).
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Approval needs an interactive terminal. Run this yourself in a terminal window.");
      }
      const reel = getReel(id);
      if (!reel) throw new Error(`Unknown reel ${id}`);
      if (cmd === "reject") {
        await updateReel(id, { status: "rejected" });
        console.log("Rejected.");
        return;
      }
      if (reel.status !== "pending_approval" && reel.status !== "approved" && reel.status !== "publish_unknown") throw new Error(`Reel ${id} is ${reel.status}; nothing to approve.`);
      const file = reelFilePath(reel);
      const seen = await reviewSnapshot(reel); // what you are shown is what gets approved
      console.log(`\nReel ${id}\n  Video:   ${file}\n  Caption (${reel.caption.length} characters):\n${reel.caption}\n`);
      if (await confirm("Open the video to watch it?", true)) openFile(file);
      if (await confirm("Approve this exact video and caption for publishing to Instagram?", false)) {
        await approveReel(id, "cli", seen);
        console.log("Approved. Ask Claude to publish it (publish_reel).");
      } else console.log("Not approved.");
      return;
    }

    case "ui": {
      const { startUi } = await import("./ui/server.js");
      const ui = await startUi();
      const link = ui.openUrl();
      console.log(`Reelwright panel (only reachable from this computer). Open this link within 30 seconds:\n\n  ${link}\n\nIt works once. Run \`reelwright ui\` again for a new one. Press Ctrl+C to close the panel.`);
      if (!flag(rest, "--no-open")) openExternal(link);
      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
      await ui.close();
      return;
    }

    case "remote": {
      const sub = rest[0] ?? "";
      if (sub === "init") {
        const urlIdx = rest.indexOf("--url");
        const file = readConfigFile();
        const secret = flag(rest, "--rotate") || !file.remote?.secret ? generateSecret() : (file.remote.secret as string);
        file.remote = { ...(file.remote ?? {}), secret, ...(urlIdx >= 0 && rest[urlIdx + 1] ? { url: rest[urlIdx + 1] } : {}) };
        saveConfigFile(file);
        console.log(`A private secret was saved in your Reelwright config. Next, in the worker/ folder of a clone of https://github.com/danikeinox/reelwright, run:

  npx wrangler secret put AGENT_SECRET

and paste this value when asked (it is shown only now; run with --rotate to make a new one):

  ${secret}

Then set your Worker's address:  reelwright remote init --url https://<your-worker>.workers.dev
See worker/README.md for the full 10-minute guide (it includes protecting the dashboard with Cloudflare Access).`);
        return;
      }
      const cfg = loadConfig();
      if (!cfg.remote.url || !cfg.remote.secret) throw new Error("Remote dashboard is not set up. Run `reelwright remote init`.");
      if (sub === "status") {
        const r = await syncOnce(cfg);
        console.log(`Connected to ${cfg.remote.url} (ran ${r.executed} command(s)).`);
        return;
      }
      console.log(`Connected to ${cfg.remote.url}. Keep this window open (Ctrl+C to stop).`);
      startRemoteLoop((m) => console.log(m));
      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
      return;
    }

    case "refresh-token": {
      const cfg = loadConfig();
      if (!cfg.instagram.accessToken) throw new Error("No Instagram token configured. Run `reelwright setup`.");
      const changed = await maybeRefreshToken((m) => console.log(m));
      if (!changed) console.log("Nothing to do (the token was refreshed recently, or is managed by REELWRIGHT_IG_TOKEN).");
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  process.stderr.write(`reelwright: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

