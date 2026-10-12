import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_KEY = "reelwright";

export function claudeDesktopConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
  }
}

/**
 * Every config file Claude Desktop may read. On Windows, the Microsoft Store (MSIX) build of
 * Claude is virtualised: it reads %LOCALAPPDATA%\\Packages\\Claude_<id>\\LocalCache\\Roaming\\Claude\\
 * instead of %APPDATA%\\Claude\\, so writing only the classic path silently does nothing.
 */
export function claudeDesktopConfigPaths(
  platform: NodeJS.Platform = process.platform,
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): string[] {
  const paths = [claudeDesktopConfigPath()];
  if (platform === "win32") {
    const packages = join(localAppData ?? join(homedir(), "AppData", "Local"), "Packages");
    try {
      for (const name of readdirSync(packages)) {
        if (/^(Anthropic\.)?Claude_[a-z0-9]+$/i.test(name)) {
          paths.push(join(packages, name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
        }
      }
    } catch {
      /* no Store apps folder */
    }
  }
  return paths;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  viaNpx: boolean;
}

/**
 * Uses absolute paths to node and to this very install, so it works even when Claude Desktop
 * starts without your shell PATH (nvm, fnm, Homebrew…). When we are running from the ephemeral
 * npx cache that path would vanish, so there we fall back to npx.
 */
export function launchSpec(): LaunchSpec {
  const script = fileURLToPath(new URL("./cli.js", import.meta.url));
  const ephemeral = /[\\/]_npx[\\/]/.test(script);
  if (ephemeral) {
    return process.platform === "win32"
      ? { command: "cmd", args: ["/c", "npx", "-y", "reelwright", "serve"], viaNpx: true }
      : { command: "npx", args: ["-y", "reelwright", "serve"], viaNpx: true };
  }
  return { command: process.execPath, args: [script, "serve"], viaNpx: false };
}

export interface InstallResult {
  configPath: string;
  changed: boolean;
  backupPath?: string;
  spec: LaunchSpec;
}

export function installIntoClaudeDesktop(configPath = claudeDesktopConfigPath(), uninstall = false): InstallResult {
  const spec = launchSpec();
  let json: Record<string, any> = {};
  let existed = false;
  if (existsSync(configPath)) {
    existed = true;
    const raw = readFileSync(configPath, "utf8");
    if (raw.trim()) {
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`${configPath} is not valid JSON; fix or delete it and try again (nothing was changed).`);
      }
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${configPath} has an unexpected shape`);
  }
  json.mcpServers ??= {};
  const before = JSON.stringify(json.mcpServers[SERVER_KEY] ?? null);
  if (uninstall) delete json.mcpServers[SERVER_KEY];
  else json.mcpServers[SERVER_KEY] = { command: spec.command, args: spec.args };
  const after = JSON.stringify(json.mcpServers[SERVER_KEY] ?? null);
  if (before === after) return { configPath, changed: false, spec };

  mkdirSync(dirname(configPath), { recursive: true });
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${configPath}.reelwright-backup`;
    copyFileSync(configPath, backupPath);
  }
  writeFileSync(configPath, JSON.stringify(json, null, 2) + "\n");
  return { configPath, changed: true, backupPath, spec };
}

/** The one-liner for Claude Code. */
export function claudeCodeCommand(): string {
  const { command, args } = launchSpec();
  const quote = (s: string) => (/[\s"']/.test(s) ? JSON.stringify(s) : s);
  return `claude mcp add reelwright -- ${[command, ...args].map(quote).join(" ")}`;
}
