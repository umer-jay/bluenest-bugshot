# Bluenest Bugshot

A Chrome extension for QA testers: select a region of any web page, annotate the screenshot, and send
it to a Notion database as a new card with metadata (URL, browser, OS, viewport, timestamp) filled in
automatically.

Internal team tool — uses a Notion internal integration token, no OAuth or backend. See
[`plan.md`](plan.md) for the full build plan and [`CLAUDE.md`](CLAUDE.md) for architecture notes.

## Status

Built step by step from `plan.md`. **Step 1 (skeleton + settings) is done.** Region select, capture/crop,
annotation, and the Notion send flow are still to come.

## Install (development)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `bluenest-bugshot/` folder.

## Notion setup

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) (or your workspace's
   Developer tools → Connections) and create a new internal connection/integration. Copy its token.
2. Create (or pick) a Notion database for QA cards, matching the property schema in `plan.md` section 6.
3. On that database, click **"•••"** → **Connections** → **Connect to** → select your integration.
4. Copy the database ID from its URL (the ID right before any `?v=`).

> If the database comes back with no properties / "no data sources" when testing, it was likely created
> as a top-level page from the sidebar. Recreate it as an inline table nested inside a page instead — see
> the note in `CLAUDE.md`.

## Settings

Right-click the extension's toolbar icon → **Options**. Paste in your integration token, database ID,
and reporter name, then click **Test connection** to confirm it can read the database and that all
expected properties exist.

## Development

No build step — vanilla JS, loaded unpacked directly. After any code change, reload the extension in
`chrome://extensions` and check the service worker console (the "service worker" link on the extension's
card) for errors.
