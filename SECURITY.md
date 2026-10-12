# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's *Report a vulnerability* (Security tab → Advisories) on this repository. You will get an answer as soon as the maintainer can; this is a volunteer project, so response times are best-effort.

## Scope and design

Reelwright runs on your computer with your privileges. The threats it is designed against:

- a hostile website or comment trying to steer the AI (prompt injection) into publishing, replying or leaking data;
- SSRF through the website reader;
- leaking tokens through logs, errors, URLs or tool output;
- swapping a video or caption between approval and publishing;
- a compromised dependency or download;
- other web pages attacking the local panel (CSRF, DNS rebinding, XSS);
- strangers or a compromised Worker attacking the optional remote dashboard.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for assets, mitigations and honest limits.

Controls: human-only approval bound to SHA-256 of video and caption; no tool takes file paths or captions at publish time; SSRF-hardened fetcher with connect-time IP validation; `0600` config; secret redaction; HTTPS-only API host; checksum-verified `cloudflared` download; stdio transport with no listening ports (apart from a short-lived loopback file server during publishing); CI with `npm audit`, CodeQL and Dependabot; npm provenance on releases.

Out of scope: an attacker who already controls your user account.

## Supported versions

Only the latest release receives fixes.
