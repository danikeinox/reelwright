# Where Instagram fetches the video from

Instagram does not accept uploads from your computer: it **downloads** the video from a public https URL. Reelwright gives it one for a few seconds and then removes it. Choose one mode in `reelwright setup`.

## Temporary tunnel (default, free, nothing is stored)

Reelwright starts a loopback-only file server that serves **one** file under a random 144-bit path, exposes it with a Cloudflare *quick tunnel* (no account needed), waits for Instagram to import it, then shuts everything down.

- Needs the `cloudflared` binary. `reelwright setup` can download the official build into `~/.reelwright/bin` and **verifies its SHA-256 against the digest GitHub publishes** before it is ever executed. Or install it yourself (`brew install cloudflared`, `winget install Cloudflare.cloudflared`, <https://pkg.cloudflare.com>).
- Quick tunnels are best-effort (no SLA) — fine for a few posts a day.
- Your computer must stay on and online while publishing.

## Your own bucket: Cloudflare R2, AWS S3 or any S3-compatible store

Reelwright uploads the video, signs a short-lived URL (default 1 hour), gives it to Instagram and **deletes the object** afterwards. The bucket stays private.

Cloudflare R2 (free tier: 10 GB storage and zero egress fees — a reel is ~2–10 MB, so you will not pay):

1. Create a bucket.
2. *R2 → Manage API tokens*: create a token with **Object Read & Write** on that bucket.
3. In `reelwright setup` choose `s3` and enter:
   - endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - region `auto`
   - bucket, access key id, secret access key

AWS S3: leave the endpoint empty, use your region, and give the IAM user `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `reelwright/*`.

Verify with `reelwright doctor --deep`: it writes, reads back through a signed URL and deletes a test object.

Cloudinary and other non-S3 services are not supported yet.
