import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FileServer {
  port: number;
  path: string;
  close: () => Promise<void>;
}

/**
 * Serves exactly one file on 127.0.0.1 under an unguessable path.
 * Supports HEAD and Range, which Instagram's fetcher may use.
 */
export async function serveSingleFile(file: string, contentType = "video/mp4"): Promise<FileServer> {
  const size = statSync(file).size;
  const path = `/${randomBytes(18).toString("base64url")}.mp4`;
  const server = http.createServer((req, res) => {
    if (req.url?.split("?")[0] !== path || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
    }
    res.writeHead(status, {
      "content-type": contentType,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    path,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
