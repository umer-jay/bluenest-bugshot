# Bluenest Bugshot

A Chrome extension for QA testers: select a region of any web page, annotate the screenshot, and send
it to a Notion database as a new card with metadata (URL, browser, OS, viewport, timestamp) filled in
automatically.

Internal team tool — uses a Notion internal integration token, no OAuth or backend. See
[`plan.md`](plan.md) for the full build plan and [`CLAUDE.md`](CLAUDE.md) for architecture notes.

## Status

Built step by step from `plan.md`. **Steps 1-4 are done:** skeleton + settings, region select, capture/crop,
and the annotation editor (text/arrow/rectangle tools, undo, color picker, title/severity/notes form,
and image export). The Notion send flow is still to come — Send currently exports and previews the
flattened image instead of posting it anywhere.

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

## Usage (so far)

Click the toolbar icon or press **Cmd+Shift+U** (Mac) / **Ctrl+Shift+U** (Windows/Linux) on any normal
web page, then drag to select a region. A new tab opens with the cropped screenshot in an editor: pick a
tool (text, arrow, or rectangle) and a color, draw on the image, undo with the button or Ctrl/Cmd+Z, fill
in a title/severity/notes, and click Send to export the flattened, resized image (it opens in a new tab
for now — actually sending it to Notion is still to come).

## Settings

Right-click the extension's toolbar icon → **Options**. Paste in your integration token, database ID,
and reporter name, then click **Test connection** to confirm it can read the database and that all
expected properties exist.

## Development

No build step — vanilla JS, loaded unpacked directly. After any code change, reload the extension in
`chrome://extensions` and check the service worker console (the "service worker" link on the extension's
card) for errors.
