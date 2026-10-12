# Changelog

## 0.2.0

- Local management panel (`reelwright ui`, MCP tool `open_dashboard`): connect Instagram/storage/voice, brand, review/edit/approve/publish. Loopback only, bearer token in the URL fragment, strict CSP, Host/Origin checks, secrets never read back.
- Optional self-hosted remote dashboard (`worker/`, `reelwright remote`): Cloudflare Worker + D1 behind Cloudflare Access; HMAC-signed, replay-protected agent channel; it can only reject reels, edit captions and change colours, never approve or publish, and never receives credentials.
- Public static site in `site/` (EN/ES, structured data, sitemap) with a GitHub Pages workflow.
- Publishing hardening from the security review: cross-process queue lock, atomic `approved → publishing` claim, `publish_unknown` state when Instagram does not confirm, hashed staging copy, cleanup on shutdown, overall fetch deadline, masked secret prompts.
- `docs/THREAT-MODEL.md`.

## 0.1.0

First release: brand reader, local Remotion renderer, optional local TTS, human-approved publishing to Instagram via tunnel or S3/R2, comment reading and confirmed replies, `setup` / `doctor` / `install-claude` / `approve` CLI.
