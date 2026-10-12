import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { Readable } from "node:stream";

/**
 * SSRF-hardened HTTP(S) GET used to read third-party websites.
 *
 *  - only http/https on ports 80/443
 *  - every resolved address is checked at connect time (defeats DNS rebinding)
 *  - IP literals are checked up-front (Node skips `lookup` for them)
 *  - redirects are followed manually and re-validated
 *  - hard caps on size (also after decompression), time and redirects
 */

const blocked = new net.BlockList();
const v4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
for (const [net_, prefix] of v4) blocked.addSubnet(net_, prefix, "ipv4");
const v6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 32], // Teredo
  ["100::", 64], // discard prefix
];
for (const [net_, prefix] of v6) blocked.addSubnet(net_, prefix, "ipv6");

/** Extracts an embedded IPv4 from ::ffff:a.b.c.d, 64:ff9b::/96 (NAT64) and 2002::/16 (6to4). */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted && (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b::"))) return dotted[1] ?? null;
  // hex form, e.g. ::ffff:7f00:1
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const nat64 = lower.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64) {
    const hi = parseInt(nat64[1]!, 16);
    const lo = parseInt(nat64[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(:|$)/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1]!, 16);
    const lo = parseInt(sixToFour[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true; // not an IP: refuse
  if (family === 4) return blocked.check(address, "ipv4");
  const mapped = embeddedV4(address);
  if (mapped && blocked.check(mapped, "ipv4")) return true;
  return blocked.check(address, "ipv6");
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  /** TESTS ONLY: allow loopback/private targets and any port. Never exposed through tools or config. */
  allowPrivateNetworkForTests?: boolean;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
}

function assertUrlAllowed(u: URL, allowPrivate: boolean): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http(s) URLs are allowed (got ${u.protocol})`);
  }
  if (u.username || u.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (!allowPrivate) {
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (port !== "80" && port !== "443") throw new UnsafeUrlError(`Port ${port} is not allowed`);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isBlockedAddress(host)) {
      throw new UnsafeUrlError("Address is in a private or reserved range");
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new UnsafeUrlError("Local hostnames are not allowed");
    }
  }
}

function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    cb: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
  ) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs ?? [];
      if (!allowPrivate && list.some((a) => isBlockedAddress(a.address))) {
        return cb(new UnsafeUrlError(`${hostname} resolves to a private or reserved address`) as NodeJS.ErrnoException);
      }
      if (list.length === 0) return cb(new Error(`No address for ${hostname}`) as NodeJS.ErrnoException);
      if (options.all) return cb(null, list);
      const first = list[0]!;
      return cb(null, first.address, first.family);
    });
  };
}

function once(url: URL, opts: Required<Omit<SafeFetchOptions, "allowPrivateNetworkForTests">> & { allowPrivate: boolean }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; location?: string }>(
    (resolve, reject) => {
      let settled = false;
      // Never pass an error to req.destroy(): once a response has started, that error is emitted on the
      // socket, which has no listener, and would crash the process. Reject ourselves, then destroy quietly.
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
        req.destroy();
      };
      const done = (v: { status: number; headers: http.IncomingHttpHeaders; body: Buffer; location?: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        url,
        {
          method: "GET",
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; Reelwright/0.1; +https://github.com/danikeinox/reelwright)",
            accept: opts.accept,
            "accept-encoding": "identity",
          },
          lookup: guardedLookup(opts.allowPrivate) as any,
          timeout: opts.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            return done({ status, headers: res.headers, body: Buffer.alloc(0), location: res.headers.location });
          }
          let stream: Readable = res;
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
          else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
          else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (c: Buffer) => {
            size += c.length;
            if (size > opts.maxBytes) return fail(new Error(`Response larger than ${opts.maxBytes} bytes`));
            chunks.push(c);
          });
          stream.on("end", () => done({ status, headers: res.headers, body: Buffer.concat(chunks) }));
          stream.on("error", (e) => fail(e));
          res.on("close", () => {
            if (!res.complete) fail(new Error("The connection closed before the response finished"));
          });
        },
      );
      req.on("timeout", () => fail(new Error(`Timed out after ${opts.timeoutMs} ms`)));
      req.on("error", (e) => fail(e));
      req.end();
    },
  );
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const allowPrivate = options.allowPrivateNetworkForTests === true;
  const opts = {
    maxBytes: options.maxBytes ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRedirects: options.maxRedirects ?? 5,
    accept: options.accept ?? "text/html,application/xhtml+xml,text/css;q=0.9,*/*;q=0.5",
    allowPrivate,
  };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  const deadline = Date.now() + opts.timeoutMs * 2; // overall cap, however slowly the server trickles bytes
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    assertUrlAllowed(url, allowPrivate);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out after ${opts.timeoutMs * 2} ms`);
    const res = await Promise.race([
      once(url, opts),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timed out after ${opts.timeoutMs * 2} ms`)), remaining).unref()),
    ]);
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "");
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url.hostname}`);
    if (!/text\/|html|xml|css|json/i.test(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }
    return { finalUrl: url.toString(), status: res.status, contentType, body: res.body.toString("utf8") };
  }
  throw new Error(`Too many redirects (>${opts.maxRedirects})`);
}
