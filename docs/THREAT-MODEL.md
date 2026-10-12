# Threat model

Reelwright runs with your privileges and controls a public Instagram account, so it is designed assuming that **websites and comments are hostile, the AI can be tricked, and anything exposed to a network will be attacked**. This document lists what is protected, how, and what is deliberately *not* promised.

## Assets

1. Instagram access token, S3/R2 keys, TTS key (full control of your accounts).
2. The ability to publish publicly under your name.
3. Your computer (files, network position).
4. Your videos and captions before publication.

## Components and trust boundaries

| Component | Exposure | Trusted to |
| --- | --- | --- |
| MCP server (stdio) | none (no ports) | Be driven by an AI that may be manipulated |
| Local panel (`reelwright ui`) | `127.0.0.1`, random port | Be used by you in your browser |
| Publish file server | loopback + Cloudflare quick tunnel, one file, secret path, only during a publish | Serve one approved video |
| Remote dashboard (optional) | Internet, in **your** Cloudflare account | Show status and make three low-impact edits |

## Key decisions

- **The AI can never approve.** No approve tool exists. Approval records the SHA-256 of the video and caption; any later change voids it. It is granted by you via terminal, the local panel, or an MCP confirmation prompt. The `open_dashboard` tool opens the panel for you and deliberately does *not* return its private link to the AI.
- **Publishing needs a local approval.** Nothing reachable from the Internet can create one.
- **No secrets in the cloud.** The remote dashboard never receives tokens or keys, and there is no command to set them. Secrets are entered only in the terminal wizard or the local panel.
- **Compromising the Worker is not enough to publish.** Even with full control of the Worker (or of your Cloudflare account) an attacker can only: reject reels, edit a caption (which voids the approval, so you must approve the new text locally), change colours, and see your reel list. They cannot approve, publish, read credentials, run code, or reach files.
- **Commands are an allowlist** validated by strict schemas on both the Worker and your computer (`reject_reel`, `set_caption`, `set_theme`). Unknown fields are rejected.

## Local panel

| Threat | Mitigation |
| --- | --- |
| Other web pages calling the panel (CSRF) | API needs `Authorization: Bearer <token>`; custom headers force a CORS preflight that is never granted; `Origin` is checked |
| DNS rebinding | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` |
| Token leakage | Token is in the URL *fragment* (never sent on the wire, no Referer), kept in `sessionStorage`, never accepted in a query string |
| XSS | No inline scripts, `script-src 'self'`, all data rendered with `textContent` |
| Secret read-back | Config API returns only `hasToken`/`hasKeys` booleans; empty secret fields never erase stored values |
| Approving something you did not see | Approve sends the hashes the page displayed; the server refuses if the video or caption changed since |
| Other users on the machine | Loopback + random token; `config.json` is `0600`. A hostile process running **as you** is out of scope |

## Remote dashboard

| Threat | Mitigation |
| --- | --- |
| Strangers reaching the dashboard | Locked (`503`) until Cloudflare Access is configured; every request must carry a valid Access JWT (RS256 signature, issuer, audience, expiry verified; `alg: none`/HMAC downgrades refused); optional `ALLOWED_EMAIL` |
| Forging the agent | HMAC-SHA256 over method, path, timestamp, nonce and body hash with a 256-bit secret; ±60 s window; nonce stored and refused on reuse; identical `401` for every failure |
| Forged or replayed commands to your computer | Responses are signed and bound to the request nonce; your computer ignores unsigned answers and never runs the same command id twice |
| CSRF from another site against your logged-in browser | Custom header `X-Requested-With`, same-origin `Origin`, `Sec-Fetch-Site`, JSON-only |
| Data exfiltration through the state channel | Strict schema with unknown fields rejected on both ends: no paths, no config, no credentials, bounded sizes |
| Flooding | Request size cap, pending-command cap, command expiry (24 h) |
| Supply chain | One dev dependency (`wrangler`), `npm audit` in CI, Dependabot, pinned deploy from your own checkout |

## Known limits (be honest with yourself)

- A page served by the Worker is trusted by your browser: if someone fully controls your Worker *code*, they control the dashboard page. That is why the dashboard has nothing powerful to abuse (see "Compromising the Worker").
- A hostile process **running as you** on your computer can read `config.json`, edit the queue file, or drive the panel. Do not give an AI client unrestricted shell or file access to your home folder if you need a hard guarantee.
- Instagram tokens are bearer credentials held in a plain `0600` file; OS-keychain storage is future work.
- The real Instagram API, Cloudflare Access and the Cloudflare tunnel have only been exercised against faithful stubs and local runtimes by the author, not against live accounts.
- Remotion (video engine) has its own licence terms for companies.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
