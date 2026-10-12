# Reelwright remote dashboard (optional)

A tiny Cloudflare Worker + D1 database **that you deploy to your own Cloudflare account**, so you can check on your reels and make low-impact edits from your phone. Nobody else runs it, nobody else has an account on it, and Reelwright works exactly the same without it.

**What it can do:** show your computer's status and your reels, let you edit a caption, reject a reel, change the default colours.
**What it can never do:** approve or publish a reel, read or store your Instagram token, bucket keys or any other secret, or run anything on your computer except those three actions. Approval always happens on your computer. See [docs/THREAT-MODEL.md](../docs/THREAT-MODEL.md).

Free-tier Cloudflare is enough (Workers, D1 and Access are all free for personal use).

## Setup (about 10 minutes)

You need a free Cloudflare account and Node.js 22.12+. Get this folder with `git clone https://github.com/danikeinox/reelwright` and open its `worker/` directory:

1. **Install and sign in**
   ```sh
   npm ci
   npx wrangler login
   ```
2. **Create the database** and paste the printed `database_id` into `wrangler.toml`:
   ```sh
   npx wrangler d1 create reelwright
   npm run db:init
   ```
3. **Create the shared secret on your computer** (the Worker and your computer must share it; it is generated locally and never leaves your machines except into your own Worker):
   ```sh
   reelwright remote init
   ```
   Copy the value it prints, then give it to the Worker:
   ```sh
   npx wrangler secret put AGENT_SECRET
   ```
4. **Deploy:**
   ```sh
   npm run deploy
   ```
   Wrangler prints your address, e.g. `https://reelwright-remote.<you>.workers.dev`.
5. **Protect it with Cloudflare Access** (this is what keeps strangers out; until you do this the dashboard answers `503 locked`):
   - Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → *Self-hosted*.
   - Application domain: your Worker's hostname. Policy: **Allow**, include **Emails** = your email only. Login method: one-time PIN is fine.
   - Add a **second** application for the path `/agent/sync` on the same hostname with a **Bypass** policy (Everyone). This path is protected by a 256-bit HMAC signature instead; your computer cannot log in through a browser.
   - Open the first application and copy its **Application Audience (AUD) tag**. Your team domain is shown under Zero Trust → Settings → Custom pages (`<team>.cloudflareaccess.com`).
6. **Tell the Worker who you are:** put the team domain and AUD tag in `wrangler.toml` (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and, optionally, `ALLOWED_EMAIL` (a second lock on top of the Access policy). Run `npm run deploy` again.
7. **Tell your computer where the Worker is** and keep it connected:
   ```sh
   reelwright remote init --url https://reelwright-remote.<you>.workers.dev
   reelwright remote status     # one test sync
   ```
   After this, any running Reelwright (Claude Desktop launching it, or `reelwright remote`) keeps the dashboard in sync every 15 seconds.

Open your Worker address in a browser: Cloudflare Access asks for your email, then you see your reels.

## Rotating the secret

`reelwright remote init --rotate`, then `npx wrangler secret put AGENT_SECRET` with the new value. Do this if you ever suspect the secret leaked.

## What is stored in your Cloudflare account

Only the latest status snapshot (reel ids, status, hook, caption, durations, permalink), a short list of recent requests, and short-lived anti-replay nonces. No videos, no file paths, no credentials.

## Updating

`git pull`, then `npm ci && npm run deploy` in this folder. Dependabot keeps `wrangler` current.
