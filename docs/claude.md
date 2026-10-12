# Connecting Reelwright to Claude and other MCP clients

## Claude Desktop

```bash
reelwright install-claude
```

It adds a `reelwright` entry to `claude_desktop_config.json` (a `.reelwright-backup` copy of the previous file is kept) using **absolute paths** to Node and to Reelwright, so it works even though Claude Desktop does not read your shell PATH. Restart Claude Desktop. `reelwright install-claude --uninstall` removes it again.

Config file locations: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`.

Manual equivalent:

```json
{
  "mcpServers": {
    "reelwright": { "command": "node", "args": ["/absolute/path/to/reelwright/dist/cli.js", "serve"] }
  }
}
```

## Claude Code

```bash
claude mcp add reelwright -- node /absolute/path/to/reelwright/dist/cli.js serve
```

(`reelwright install-claude --print` prints the exact command for your install.)

## Cursor and other MCP clients

Any client that can launch a stdio server works: command `node`, args `[".../dist/cli.js", "serve"]`. If the client launches the command with no arguments and no terminal, `reelwright` also starts the server on its own.

## Approving posts

Clients that support MCP *elicitation* show you a confirmation prompt when Claude calls `publish_reel`. For the others, approve in a terminal:

```bash
reelwright list
reelwright approve r_1a2b3c4d5e   # shows the file and caption, asks for confirmation
```

Then ask Claude to publish again.
