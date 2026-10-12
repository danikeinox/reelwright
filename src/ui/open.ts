import { spawn } from "node:child_process";

/** Opens a file or http(s) URL with the OS default handler. Never throws. */
export function openExternal(target: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* the URL is printed anyway */
  }
}
