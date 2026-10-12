# Changelog

## Unreleased

- **Scene reels**: `render_reel` accepts `scenes` instead of hook/lines: `title`, `phone` (a screenshot inside a 3D phone), `card` (animated status card: before → after with countdown → tap → done), `list`, `price` (count-up) and `cta` (logo + button), with crossfades and Instagram-safe layout. Plain text reels are unchanged.
- **Logo**: `reelwright logo <file>` (PNG/WebP/JPEG, sniffed by content, transparent margins trimmed at render time). Shown at the top of text reels and on the first/last scene of scene reels.
- **Media library**: `reelwright media add <file> --name <name>` for screenshots; new MCP tool `list_media`. The AI only refers to screenshots by name; it can never pass a path.
- **Background music**: `reelwright music <file>` (WAV/MP3/M4A), faded in and out; on by default for scene reels, opt-in for text reels.
- `doctor` reports logo, screenshots and music.
- **Windows / Microsoft Store Claude**: `install-claude` and `setup` now also write the MSIX-virtualised config (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`); before, the Store build never saw Reelwright.

## 0.2.0

- Local management panel (`reelwright ui`, MCP tool `open_dashboard`): connect Instagram/storage/voice, brand, review/edit/approve/publish. Loopback only, bearer token in the URL fragment, strict CSP, Host/Origin checks, secrets never read back.
- Optional self-hosted remote dashboard (`worker/`, `reelwright remote`): Cloudflare Worker + D1 behind Cloudflare Access; HMAC-signed, replay-protected agent channel; it can only reject reels, edit captions and change colours, never approve or publish, and never receives credentials.
- Public static site in `site/` (EN/ES, structured data, sitemap) with a GitHub Pages workflow.
- Publishing hardening from the security review: cross-process queue lock, atomic `approved → publishing` claim, `publish_unknown` state when Instagram does not confirm, hashed staging copy, cleanup on shutdown, overall fetch deadline, masked secret prompts.
- `docs/THREAT-MODEL.md`.

## 0.1.0

First release: brand reader, local Remotion renderer, optional local TTS, human-approved publishing to Instagram via tunnel or S3/R2, comment reading and confirmed replies, `setup` / `doctor` / `install-claude` / `approve` CLI.
