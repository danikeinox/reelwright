# Connecting Instagram

Reelwright publishes through the official **Instagram API with Instagram Login**. You use your **own** Meta developer app, so there is no shared app, no app review and nothing to trust but yourself.

> Meta renames menus often. If a step below does not match your screen, follow the current official guide:
> <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login>

## What you need

- An Instagram **Business or Creator** (professional) account. Switch in the Instagram app: *Settings → Account type and tools*.
- A free [Meta for Developers](https://developers.facebook.com) account.

## Steps

1. In Meta for Developers, **Create app** and pick the use case for managing messaging and content on Instagram (the one that gives you the *Instagram API with Instagram login*).
2. Open the Instagram product → **API setup with Instagram login**.
3. Add your Instagram account as a tester/role if the dashboard asks, and accept the invitation inside Instagram (*Settings → Apps and websites → Tester invites*).
4. In **Generate access tokens**, generate a token for your account and grant the permissions:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments` (only needed to read and reply to comments)
5. Copy the token and run `reelwright setup`. It verifies the token, finds your numeric Instagram user id and stores both with owner-only permissions.

Check with `reelwright doctor`: it should say `connected as @yourname`.

## Tokens

Tokens last 60 days. **Reelwright renews yours automatically** whenever it starts and the token is older than 20 days, so as long as you use it at least once every couple of months you never touch it again. (Meta only allows renewing tokens that are at least 24 hours old; if you generate a fresh one, the first renewal simply happens on a later start.) If you let it expire, generate a new token and run `reelwright setup` again.

Tokens given through `REELWRIGHT_IG_TOKEN` are yours to manage and are never rewritten.

## Limits

Instagram caps API publishing per account (documented as roughly 50–100 posts per rolling 24 hours). Reelwright is meant for a handful a day. Videos must meet Instagram's reel requirements; Reelwright renders 1080×1920 (9:16), H.264 + AAC, up to 90 seconds.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| "access token is invalid or expired" | Generate a new token and run `reelwright setup` |
| "Missing permission" | Re-generate the token with the permissions above |
| "Instagram could not process the video" | Usually a temporary URL problem; run `reelwright doctor --deep`, retry `publish_reel` |
| "Instagram user id is missing" | Run `reelwright setup` again with the token |
