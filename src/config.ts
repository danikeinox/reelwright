import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/** Where Reelwright keeps everything. Override with REELWRIGHT_HOME. */
export function getPaths() {
  const home = resolve(process.env.REELWRIGHT_HOME ?? join(homedir(), ".reelwright"));
  return {
    home,
    config: join(home, "config.json"),
    brand: join(home, "brand.json"),
    queue: join(home, "queue.json"),
    reels: join(home, "reels"),
    tmp: join(home, "tmp"),
    bin: join(home, "bin"),
    /** Has a package.json so Remotion caches its browser here, not in the user's cwd. */
    runtime: join(home, "runtime"),
  };
}

export function ensureDirs(): ReturnType<typeof getPaths> {
  const p = getPaths();
  for (const dir of [p.home, p.reels, p.tmp, p.bin, p.runtime]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const pkg = join(p.runtime, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, JSON.stringify({ name: "reelwright-runtime", private: true }) + "\n");
  }
  return p;
}

/** https, or plain http only to this very computer. Keeps stored secrets from travelling in clear text. */
const httpsOrLoopback = (u: string) => {
  const x = new URL(u);
  return x.protocol === "https:" || (x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname));
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "use a 6-digit hex colour like #ff5a1f");

/** Instagram API host must be HTTPS (plain http only for local test servers). */
const apiHost = z
  .string()
  .url()
  .refine((u) => {
    const url = new URL(u);
    return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
  }, "instagram.apiHost must use https");

export const ConfigSchema = z.object({
  instagram: z
    .object({
      accessToken: z.string().min(10).optional(),
      userId: z.string().regex(/^\d+$/, "userId is numeric").optional(),
      apiVersion: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
      apiHost: apiHost.default("https://graph.instagram.com"),
      /** ISO date of the last successful token refresh (used for automatic renewal). */
      tokenRefreshedAt: z.string().optional(),
    })
    .default({ apiVersion: "v25.0", apiHost: "https://graph.instagram.com" }),
  storage: z
    .object({
      mode: z.enum(["tunnel", "s3"]).default("tunnel"),
      s3: z
        .object({
          endpoint: z.string().url().refine(httpsOrLoopback, "s3.endpoint must use https").optional(),
          region: z.string().default("auto"),
          bucket: z.string().min(1),
          accessKeyId: z.string().min(1),
          secretAccessKey: z.string().min(1),
          prefix: z.string().default("reelwright/"),
          forcePathStyle: z.boolean().default(false),
          signedUrlTtlSeconds: z.number().int().min(300).max(86400).default(3600),
        })
        .optional(),
    })
    .default({ mode: "tunnel" }),
  tts: z
    .object({
      enabled: z.boolean().default(false),
      /** OpenAI-compatible base URL, e.g. your local VoiceStudio: http://127.0.0.1:PORT/v1 */
      baseUrl: z.string().url().refine(httpsOrLoopback, "tts.baseUrl must use https (or http://127.0.0.1 for a local server)").optional(),
      model: z.string().default("voicestudio"),
      voice: z.string().default("default"),
      apiKey: z.string().optional(),
    })
    .default({ enabled: false, model: "voicestudio", voice: "default" }),
  render: z
    .object({
      /** Path to a Chrome/Chromium/Edge binary. Leave empty to use Remotion's own downloaded browser. */
      browserExecutable: z.string().optional(),
      concurrency: z.number().int().min(1).max(32).optional(),
    })
    .default({}),
  safety: z
    .object({
      /** Replies are public text posted on your behalf: ask the human first. */
      confirmReplies: z.boolean().default(true),
    })
    .default({ confirmReplies: true }),
  defaultTheme: z.object({ bg: hexColor, fg: hexColor, accent: hexColor }).optional(),
  /** Optional self-hosted remote dashboard (see worker/README.md). */
  remote: z
    .object({
      url: z
        .string()
        .url()
        .refine((u) => {
          const x = new URL(u);
          return x.protocol === "https:" || ["127.0.0.1", "localhost"].includes(x.hostname);
        }, "remote.url must use https")
        .optional(),
      /** 256-bit hex secret shared with the Worker (AGENT_SECRET). */
      secret: z.string().regex(/^[0-9a-f]{64}$/, "remote.secret must be 64 hex characters").optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: it is not valid JSON (fix or delete it; the error text is hidden because the file holds secrets).`);
  }
}

/** Loads config.json and lets environment variables override secrets. */
export function loadConfig(): Config {
  const raw = readJson(getPaths().config) as Record<string, any>;
  const env = process.env;
  raw.instagram ??= {};
  if (env.REELWRIGHT_IG_TOKEN) raw.instagram.accessToken = env.REELWRIGHT_IG_TOKEN;
  if (env.REELWRIGHT_IG_USER_ID) raw.instagram.userId = env.REELWRIGHT_IG_USER_ID;
  if (env.REELWRIGHT_S3_BUCKET && env.REELWRIGHT_S3_ACCESS_KEY_ID && env.REELWRIGHT_S3_SECRET_ACCESS_KEY) {
    raw.storage ??= {};
    raw.storage.mode = "s3";
    raw.storage.s3 = {
      ...(raw.storage.s3 ?? {}),
      bucket: env.REELWRIGHT_S3_BUCKET,
      accessKeyId: env.REELWRIGHT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.REELWRIGHT_S3_SECRET_ACCESS_KEY,
      ...(env.REELWRIGHT_S3_ENDPOINT ? { endpoint: env.REELWRIGHT_S3_ENDPOINT } : {}),
      ...(env.REELWRIGHT_S3_REGION ? { region: env.REELWRIGHT_S3_REGION } : {}),
    };
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration (${getPaths().config}): ${issues}`);
  }
  return parsed.data;
}

/** Atomic write with owner-only permissions (config can contain secrets). */
export function writeSecureJson(file: string, data: unknown): void {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on some filesystems (Windows) */
  }
}

/** Reads the file-backed config (without env overrides) so saving never persists env secrets. */
export function readConfigFile(): Record<string, any> {
  return readJson(getPaths().config) as Record<string, any>;
}

export function saveConfigFile(next: Record<string, any>): void {
  ensureDirs();
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Refusing to save invalid configuration: ${issues}`);
  }
  writeSecureJson(getPaths().config, next);
}

/** Removes anything that looks like a credential from text destined for logs or tool output. */
export function redact(text: string, cfg?: Config): string {
  let out = text.replace(/(access_token=)[^&\s"']+/gi, "$1[redacted]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/g, "$1[redacted]");
  const secrets = [
    cfg?.instagram.accessToken,
    cfg?.storage.s3?.secretAccessKey,
    cfg?.storage.s3?.accessKeyId,
    cfg?.tts.apiKey,
    cfg?.remote.secret,
  ].filter((s): s is string => !!s && s.length >= 8);
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}
