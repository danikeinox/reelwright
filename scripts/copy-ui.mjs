// The panel's static files are plain assets: copy them next to the compiled server.
import { cpSync, mkdirSync } from "node:fs";
const base = process.argv[2] ?? "dist/ui";
mkdirSync(base, { recursive: true });
cpSync("src/ui/public", `${base}/public`, { recursive: true });
