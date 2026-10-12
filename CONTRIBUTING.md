# Contributing

Thanks for helping! The project goal is a **small, boring, low-maintenance** tool, so changes that add moving parts need a good reason.

```bash
npm ci
npm test       # build + unit tests + end-to-end (downloads a headless Chrome once, ~100 MB)
npm run typecheck
npm run audit:prod
```

Guidelines

- Keep runtime dependencies few. Prefer Node built-ins.
- Anything that touches the network, files or secrets needs a test. Instagram and S3 are tested against local fakes in `test/helpers.ts`; please extend those rather than calling real services.
- Never add a tool that lets the AI approve, bypass confirmations, or accept arbitrary paths/URLs to publish.
- Never print to stdout while serving: stdout is the MCP channel.
- Node support: current LTS lines (22 and 24).
