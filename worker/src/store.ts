/** Storage abstraction: D1 in production, an in-memory twin in tests. */
export interface StoredCommand {
  id: string;
  body: string; // JSON of a validated Command
  status: "pending" | "delivered" | "done" | "failed";
  createdAt: number;
  expiresAt: number;
  error?: string;
}

export interface Store {
  putState(json: string, now: number): Promise<void>;
  getState(): Promise<{ json: string; updatedAt: number } | null>;
  /** Returns false when this nonce was already used (replay). Also prunes expired nonces. */
  useNonce(nonce: string, now: number, ttlMs: number): Promise<boolean>;
  addCommand(c: StoredCommand): Promise<void>;
  countPending(now: number): Promise<number>;
  takePending(limit: number, now: number): Promise<StoredCommand[]>;
  recordResult(id: string, ok: boolean, error: string | undefined): Promise<void>;
  recent(limit: number): Promise<StoredCommand[]>;
}

export class MemoryStore implements Store {
  state: { json: string; updatedAt: number } | null = null;
  nonces = new Map<string, number>();
  commands = new Map<string, StoredCommand>();

  async putState(json: string, now: number) {
    this.state = { json, updatedAt: now };
  }
  async getState() {
    return this.state;
  }
  async useNonce(nonce: string, now: number, ttlMs: number) {
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, now + ttlMs);
    return true;
  }
  async addCommand(c: StoredCommand) {
    this.commands.set(c.id, { ...c });
  }
  async countPending(now: number) {
    return [...this.commands.values()].filter((c) => c.status === "pending" && c.expiresAt > now).length;
  }
  async takePending(limit: number, now: number) {
    const out = [...this.commands.values()].filter((c) => c.status === "pending" && c.expiresAt > now).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    for (const c of out) c.status = "delivered";
    return out.map((c) => ({ ...c }));
  }
  async recordResult(id: string, ok: boolean, error: string | undefined) {
    const c = this.commands.get(id);
    if (c && c.status === "delivered") {
      c.status = ok ? "done" : "failed";
      c.error = error;
    }
  }
  async recent(limit: number) {
    return [...this.commands.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((c) => ({ ...c }));
  }
}

// Minimal structural types so this file needs no Cloudflare typings.
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown>;
}

export class D1Store implements Store {
  constructor(private readonly db: D1Like) {}

  async putState(json: string, now: number) {
    await this.db.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('state', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?1, updated_at = ?2").bind(json, now).run();
  }
  async getState() {
    const r = await this.db.prepare("SELECT v, updated_at FROM kv WHERE k = 'state'").first<{ v: string; updated_at: number }>();
    return r ? { json: r.v, updatedAt: r.updated_at } : null;
  }
  async useNonce(nonce: string, now: number, ttlMs: number) {
    await this.db.prepare("DELETE FROM nonces WHERE expires_at < ?1").bind(now).run();
    try {
      await this.db.prepare("INSERT INTO nonces (nonce, expires_at) VALUES (?1, ?2)").bind(nonce, now + ttlMs).run();
      return true;
    } catch {
      return false; // primary-key violation = replay
    }
  }
  async addCommand(c: StoredCommand) {
    await this.db.prepare("INSERT INTO commands (id, body, status, created_at, expires_at) VALUES (?1, ?2, 'pending', ?3, ?4)").bind(c.id, c.body, c.createdAt, c.expiresAt).run();
  }
  async countPending(now: number) {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'pending' AND expires_at > ?1").bind(now).first<{ n: number }>();
    return r?.n ?? 0;
  }
  async takePending(limit: number, now: number) {
    const rows = (await this.db.prepare("SELECT id, body, created_at, expires_at FROM commands WHERE status = 'pending' AND expires_at > ?1 ORDER BY created_at LIMIT ?2").bind(now, limit).all<{ id: string; body: string; created_at: number; expires_at: number }>()).results;
    const taken: StoredCommand[] = [];
    for (const r of rows) {
      // Only the request that flips pending -> delivered hands the command out (no double delivery).
      const res = (await this.db.prepare("UPDATE commands SET status = 'delivered' WHERE id = ?1 AND status = 'pending' RETURNING id").bind(r.id).first()) as unknown;
      if (res) taken.push({ id: r.id, body: r.body, status: "delivered", createdAt: r.created_at, expiresAt: r.expires_at });
    }
    return taken;
  }
  async recordResult(id: string, ok: boolean, error: string | undefined) {
    await this.db.prepare("UPDATE commands SET status = ?2, error = ?3 WHERE id = ?1 AND status = 'delivered'").bind(id, ok ? "done" : "failed", error ?? null).run();
  }
  async recent(limit: number) {
    const rows = (await this.db.prepare("SELECT id, body, status, created_at, expires_at, error FROM commands ORDER BY created_at DESC LIMIT ?1").bind(limit).all<{ id: string; body: string; status: StoredCommand["status"]; created_at: number; expires_at: number; error: string | null }>()).results;
    return rows.map((r) => ({ id: r.id, body: r.body, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, error: r.error ?? undefined }));
  }
}
