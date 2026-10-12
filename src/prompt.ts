import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question: string, opts: { secret?: boolean; def?: string } = {}): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  try {
    const suffix = opts.def ? (opts.secret ? " [Enter keeps the current value]" : ` [${opts.def}]`) : "";
    process.stdout.write(`${question}${suffix}: `);
    muted = Boolean(opts.secret);
    const answer = (await rl.question("")).trim();
    muted = false;
    if (opts.secret) process.stdout.write("\n");
    return answer || opts.def || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, def = false): Promise<boolean> {
  const a = (await ask(`${question} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  if (!a) return def;
  return a === "y" || a === "yes" || a === "s" || a === "si" || a === "sí";
}
