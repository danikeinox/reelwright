/** Registry of teardown actions (tunnel process, temporary S3 object) run when the server shuts down. */
const tasks = new Set<() => Promise<void>>();

export function registerCleanup(fn: () => Promise<void>): () => void {
  tasks.add(fn);
  return () => tasks.delete(fn);
}

export async function runCleanups(timeoutMs = 5_000): Promise<void> {
  const all = [...tasks].map((t) => t().catch(() => undefined));
  await Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, timeoutMs))]);
}
