import { handle, type Env } from "./handler.js";
import { D1Store, type D1Like } from "./store.js";

export default {
  async fetch(request: Request, env: Env & { DB: D1Like }): Promise<Response> {
    try {
      return await handle(request, env, new D1Store(env.DB));
    } catch {
      // never leak internals
      return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } });
    }
  },
};
