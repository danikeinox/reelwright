import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeCommand, claudeDesktopConfigPath, installIntoClaudeDesktop, launchSpec } from "../src/install.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rw-install-"));
}

describe("install-claude", () => {
  it("creates the config when missing", () => {
    const dir = tmp();
    try {
      const file = join(dir, "sub", "claude_desktop_config.json");
      const r = installIntoClaudeDesktop(file);
      assert.equal(r.changed, true);
      const json = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(json.mcpServers.reelwright.args.at(-1), "serve");
      assert.equal(r.backupPath, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges with existing servers and settings, keeps a backup, and is idempotent", () => {
    const dir = tmp();
    try {
      const file = join(dir, "claude_desktop_config.json");
      writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: ["y"] } } }));
      const r1 = installIntoClaudeDesktop(file);
      assert.equal(r1.changed, true);
      assert.ok(r1.backupPath && existsSync(r1.backupPath));
      assert.equal(JSON.parse(readFileSync(r1.backupPath!, "utf8")).mcpServers.reelwright, undefined);
      const json = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(json.theme, "dark");
      assert.deepEqual(json.mcpServers.other, { command: "x", args: ["y"] });
      assert.ok(json.mcpServers.reelwright);
      assert.equal(installIntoClaudeDesktop(file).changed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uninstalls only its own entry", () => {
    const dir = tmp();
    try {
      const file = join(dir, "c.json");
      writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
      installIntoClaudeDesktop(file);
      installIntoClaudeDesktop(file, true);
      const json = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(Object.keys(json.mcpServers), ["other"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to touch a config that is not valid JSON", () => {
    const dir = tmp();
    try {
      const file = join(dir, "c.json");
      writeFileSync(file, "{ nope");
      assert.throws(() => installIntoClaudeDesktop(file), /not valid JSON/);
      assert.equal(readFileSync(file, "utf8"), "{ nope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses absolute paths so Claude does not depend on the shell PATH", () => {
    const spec = launchSpec();
    if (!spec.viaNpx) {
      assert.ok(spec.command.startsWith("/") || /^[A-Za-z]:\\/.test(spec.command));
      assert.ok(spec.args[0]!.endsWith("cli.js"));
    }
    assert.match(claudeCodeCommand(), /^claude mcp add reelwright -- /);
    assert.ok(claudeDesktopConfigPath().endsWith("claude_desktop_config.json"));
  });
});

describe("Claude Desktop from the Microsoft Store", () => {
  it("also targets the virtualised MSIX config folder on Windows", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { claudeDesktopConfigPaths } = await import("../src/install.js");
    const local = mkdtempSync(join(tmpdir(), "rw-local-"));
    try {
      mkdirSync(join(local, "Packages", "Claude_abc123xyz"), { recursive: true });
      mkdirSync(join(local, "Packages", "NotClaude_abc"), { recursive: true });
      const paths = claudeDesktopConfigPaths("win32", local);
      assert.equal(paths.length, 2);
      assert.equal(paths[1], join(local, "Packages", "Claude_abc123xyz", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
      assert.equal(claudeDesktopConfigPaths("linux", local).length, 1);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});
