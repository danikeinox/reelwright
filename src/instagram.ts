import { redact, type Config } from "./config.js";

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "InstagramError";
  }
}

const HINTS: Record<number, string> = {
  190: "The access token is invalid or expired. Generate a new one in the Meta developer dashboard and run `reelwright setup`.",
  10: "Missing permission. The token needs instagram_business_content_publish.",
  200: "Missing permission. The token needs instagram_business_content_publish.",
  4: "Meta rate limit reached. Wait a while and retry.",
  9: "Meta rate limit reached. Wait a while and retry.",
  100: "Meta rejected a parameter (check the video URL is public and the account is a Business/Creator account).",
};

export interface CommentItem {
  id: string;
  text: string;
  username?: string;
  timestamp?: string;
}

export class InstagramClient {
  constructor(private readonly cfg: Config) {
    if (!cfg.instagram.accessToken) throw new Error("Instagram is not connected. Run `reelwright setup` to add your access token.");
  }

  private get base(): string {
    return `${this.cfg.instagram.apiHost}/${this.cfg.instagram.apiVersion}`;
  }

  private get userId(): string {
    const id = this.cfg.instagram.userId;
    if (!id) throw new Error("Instagram user id is missing. Run `reelwright setup`.");
    return id;
  }

  private async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<any> {
    const all = { ...params, access_token: this.cfg.instagram.accessToken! };
    let res: Response;
    try {
      if (method === "GET") {
        res = await fetch(`${this.base}/${path}?${new URLSearchParams(all)}`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      } else {
        res = await fetch(`${this.base}/${path}`, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(all),
          signal: AbortSignal.timeout(path.endsWith("/media_publish") ? 180_000 : 60_000),
        });
      }
    } catch (e) {
      throw new InstagramError(`Network error talking to Instagram: ${redact((e as Error).message, this.cfg)}`);
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new InstagramError(`Instagram returned a non-JSON answer (HTTP ${res.status})`);
    }
    if (!res.ok || json?.error) {
      const err = json?.error ?? {};
      const hint = HINTS[err.code as number];
      throw new InstagramError(
        redact(`${err.message ?? `HTTP ${res.status}`}${hint ? ` — ${hint}` : ""}`, this.cfg),
        err.code,
        err.error_subcode,
      );
    }
    return json;
  }

  me(): Promise<{ user_id?: string; id?: string; username?: string; account_type?: string }> {
    return this.call("GET", "me", { fields: "user_id,username,account_type" });
  }

  async createReelContainer(videoUrl: string, caption: string): Promise<string> {
    const json = await this.call("POST", `${this.userId}/media`, { media_type: "REELS", video_url: videoUrl, caption });
    if (!json.id) throw new InstagramError("Instagram did not return a container id");
    return String(json.id);
  }

  async waitUntilReady(containerId: string, opts: { intervalMs?: number; maxWaitMs?: number } = {}): Promise<void> {
    const interval = opts.intervalMs ?? 8_000;
    const deadline = Date.now() + (opts.maxWaitMs ?? 6 * 60_000);
    for (;;) {
      const s = await this.call("GET", containerId, { fields: "status_code,status" });
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") {
        throw new InstagramError(`Instagram could not process the video (${s.status_code}${s.status ? `: ${s.status}` : ""})`);
      }
      if (Date.now() > deadline) throw new InstagramError("Instagram is still processing the video after 6 minutes; try again later.");
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async publish(containerId: string): Promise<{ mediaId: string; permalink?: string }> {
    const json = await this.call("POST", `${this.userId}/media_publish`, { creation_id: containerId });
    const mediaId = String(json.id);
    let permalink: string | undefined;
    try {
      permalink = (await this.call("GET", mediaId, { fields: "permalink" })).permalink;
    } catch {
      /* the post is live even if the permalink lookup fails */
    }
    return { mediaId, permalink };
  }

  async listComments(mediaId: string, limit = 25): Promise<CommentItem[]> {
    const json = await this.call("GET", `${mediaId}/comments`, {
      fields: "id,text,username,timestamp",
      limit: String(Math.min(Math.max(limit, 1), 50)),
    });
    return (json.data ?? []) as CommentItem[];
  }

  async replyToComment(commentId: string, message: string): Promise<string> {
    const json = await this.call("POST", `${commentId}/replies`, { message });
    return String(json.id);
  }

  /** Long-lived tokens last 60 days; refreshing extends them. Returns the new token. */
  async refreshToken(): Promise<{ token: string; expiresInSeconds?: number }> {
    const url = `${this.cfg.instagram.apiHost}/refresh_access_token?${new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: this.cfg.instagram.accessToken!,
    })}`;
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new InstagramError(redact(json?.error?.message ?? `Token refresh failed (HTTP ${res.status})`, this.cfg), json?.error?.code);
    }
    return { token: String(json.access_token), expiresInSeconds: json.expires_in };
  }
}
