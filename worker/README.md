# Bluenest Bugshot — OAuth Worker

Cloudflare Worker that holds the Notion OAuth client secret and the per-install token pairs, so the
Chrome extension itself never has to. See `plan.md` section 14 in the repo root for the full
architecture and reasoning.

## One-time setup

1. Install the Wrangler CLI if you don't have it:
   ```
   npm install -g wrangler
   ```
2. Log in (opens a browser to authenticate with your Cloudflare account):
   ```
   wrangler login
   ```
3. Create the KV namespace that stores token pairs:
   ```
   wrangler kv namespace create TOKENS
   ```
   This prints an `id`. Paste it into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
4. Set the Notion OAuth secrets (from registering the public integration — see `plan.md` section 14).
   These prompt for the value interactively and are never written to a file in this repo:
   ```
   wrangler secret put NOTION_CLIENT_ID
   wrangler secret put NOTION_CLIENT_SECRET
   ```
5. Deploy:
   ```
   wrangler deploy
   ```
   This prints the Worker's URL (something like `https://bluenest-bugshot-oauth.<your-subdomain>.workers.dev`).
   That URL needs to go into the extension's `oauth.js` (`WORKER_BASE_URL`) and into `manifest.json`'s
   `host_permissions`.

## Local development

```
wrangler dev
```

Runs the Worker locally. You'll need local equivalents of the KV namespace and secrets — Wrangler's
`--local` flag or a `.dev.vars` file (gitignored) can hold secrets for local testing; see
[Wrangler's docs](https://developers.cloudflare.com/workers/configuration/secrets/) for the current
recommended approach, since this evolves.

## Routes

| Route | Method | Body / Query | Returns |
|---|---|---|---|
| `/exchange` | POST | `{ code, installId, redirectUri }` | `{ workspaceName, workspaceIcon }` |
| `/token` | GET | `?installId=...` | `{ accessToken, workspaceName }` |
| `/refresh` | POST | `{ installId }` | `{ accessToken }` |

`installId` is a random UUID the extension generates once per install (`crypto.randomUUID()`) and
persists in `chrome.storage.local` — it's the only thing tying a browser install to its KV record. This
Worker never learns who the human using it is.

## Checking it's alive

```
curl https://<your-worker-url>/
```
should return `{"status":"ok"}`.
