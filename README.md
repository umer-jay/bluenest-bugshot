# Bluenest Bugshot

A Chrome extension for QA testers: select a region of any web page, annotate it, and send it to a Notion
database as a new card — screenshot included, with metadata (page URL, browser, OS, viewport, timestamp)
filled in automatically.

Internal team tool — uses a Notion internal integration token, no OAuth or backend, no Chrome Web Store
listing. See [`plan.md`](plan.md) for the full build plan and [`CLAUDE.md`](CLAUDE.md) for architecture
notes if you're developing on it.

## 1. Install

1. Download or `git clone` this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the `bluenest-bugshot/` folder (the one containing `manifest.json`,
   not the repo root).
5. A "Bluenest Bugshot" card should appear, with its icon in your toolbar (pin it via the puzzle-piece
   icon if you don't see it).

## 2. Set up your Notion integration

You only need to do this once per Notion workspace.

1. Go to `app.notion.com`, then **Settings → Developer tools → Connections** (or
   `notion.so/my-integrations`, which redirects there).
2. Click **"+ New connection"**.
   - If **"API token"** is grayed out with a permission error, you're in a workspace where only admins
     can create one. Either ask your workspace admin to create it for you, or switch to a workspace
     where you're the owner (the workspace switcher is top-left) — click "Add a workspace" there if you
     don't have one yet.
3. Give it a name (the "Create connection" button stays disabled until you type one) and choose the
   **API token** authentication method, not OAuth.
4. Once created, make sure its capabilities include **Read content**, **Update content**, and
   **Insert content** (Configuration tab).
5. Copy its **API token** (the masked field with a copy icon).

## 3. Set up the QA Pipeline database

1. Create a database with exactly these properties (names and types matter — they must match
   character-for-character, see `plan.md` section 6, and `notion.js`'s `NOTION_PROPERTIES`):

   | Name | Type |
   |---|---|
   | Title | Title |
   | Status | Status (or Select) |
   | Severity | Select — options: Low, Medium, High, Critical |
   | Page URL | URL |
   | Page Title | Text |
   | Browser | Text |
   | OS | Text |
   | Viewport | Text |
   | Pixel Ratio | Number |
   | Captured At | Date |
   | Reporter | Text |
   | Notes | Text |

   Tip: you can ask Notion AI to build this for you — see the prompt example in this project's history,
   or just build it by hand with "+" to add each property.

   **Important:** create it as an inline table *nested inside a page* (type `/table` inside a page and
   choose "Table - inline"), not via "+ New page" → "Table" from the sidebar directly. We hit a real
   Notion bug where that second method can create a broken database with no usable schema — the
   extension will show "This database has no data sources" if you run into it. If that happens, just
   recreate it the first way.

2. On that database, click **"•••"** (top-right) → **Connections** → **Connect to** → select your
   integration from step 2. Without this, every request gets a 404 even with a valid token.
3. Copy the database's ID: hover the table, click the expand icon (⤢) to "Open as page" if it's inline,
   and copy the ID from the URL — the long string right before any `?v=`.

## 4. Configure the extension

1. Right-click the extension's toolbar icon → **Options** (or **Details** → **Extension options** from
   `chrome://extensions`).
2. Paste in your integration token and database ID, and your name under Reporter.
3. Click **Save**, then **Test connection** — you should see "Connected to [name]. All expected
   properties found." If it lists missing properties, fix the database schema and test again.

## 5. Use it

1. Pick a capture mode, on any normal web page (not a `chrome://` page or the Chrome Web Store — those
   can't be captured):
   - **Select a region** — click the toolbar icon, or **Cmd+Shift+U** (Mac) / **Ctrl+Shift+U**
     (Windows/Linux). Drag to select the area you want; Esc cancels, releasing confirms.
   - **Capture the visible area** — right-click the toolbar icon → "Capture visible area", or
     **Cmd+Shift+Y** / **Ctrl+Shift+Y**. No selection needed, captures exactly what's on screen.
   - **Capture the full page** — right-click the toolbar icon → "Capture full page", or
     **Cmd+Shift+F** / **Ctrl+Shift+F**. Scrolls and stitches the whole page into one image (takes a few
     seconds on a long page; very long pages are capped rather than captured in full). One known
     limitation: fixed headers/banners will appear duplicated at each stitch point.
2. A new tab opens with the captured screenshot. Pick a tool — **Select** (pointer icon, pauses drawing),
   **Move** (drag an existing annotation to reposition it; Esc cancels mid-drag), **T** (text — click,
   type, Enter to confirm), **↗** (arrow), **▢** (rectangle) — and a color, then draw on the image. Use
   the **− / +** stepper to set the text size (10–48px) before placing a text annotation; it applies to
   the next one you create, not to text already placed. Undo (button or Ctrl/Cmd+Z) reverts the last
   change, whatever it was — adding a shape, moving one, or Clear; Clear wipes everything.
3. Fill in a Title (required), Severity, and Notes.
4. Click **Send**. It uploads the flattened screenshot and creates a card in your QA Pipeline database,
   then shows a link to open it. If you just want the image itself, **Copy Image** copies it to your
   clipboard to paste elsewhere (Slack, docs, etc.) instead.

## Troubleshooting

- **Nothing happens when I click the icon on some pages** — Chrome blocks extensions from capturing its
  own internal pages (`chrome://...`) and the Web Store; you'll get a system notification saying so.
- **"Invalid Notion token"** — re-check the token in Settings; it may have been copied with extra
  whitespace, or the connection was deleted in Notion.
- **"Database not found" / 404** — the database isn't shared with your connection yet (step 3.2 above).
- **"This database has no data sources"** — the database was likely created as a top-level page instead
  of an inline table — see the note in step 3.1.
- **A property is reported missing** — the name in Notion doesn't match the table in step 3.1 exactly.

## Development

No build step — vanilla JS, loaded unpacked directly. After any code change, reload the extension in
`chrome://extensions` and check the service worker console (the "service worker" link on the extension's
card) for errors. See `CLAUDE.md` for architecture and implementation notes.

## Changelog

- **v1.2.0** — Two new capture modes, via right-click on the toolbar icon or a keyboard shortcut:
  **Capture visible area** (no selection needed) and **Capture full page** (scrolls and stitches the
  whole page into one image; very long pages are capped, and fixed headers/banners duplicate at each
  stitch seam — a known limitation, not a bug).
- **v1.1.1** — Hardening from a Chrome extension best-practices audit: explicit CSP in the manifest,
  a 20s timeout on Notion API calls (so a hung connection can't leave Send stuck forever), and some
  defense-in-depth message validation in the background script. No user-visible behavior change.
- **v1.1.0** — Added a Move tool: click and drag an existing annotation to reposition it (Esc cancels
  an in-progress move). Rebuilt Undo as a proper history of snapshots instead of "remove the last
  annotation," so it now correctly reverts a move (or a Clear) instead of deleting an unrelated shape.
  Added a text size stepper (10–48px) instead of a fixed 16px.
- **v1.0.1** — Real app icon (was a placeholder red square). Fixed the text annotation tool: its
  committed size/position on the image could drift noticeably from what you saw while typing, and white
  text was invisible while typing (input box background is now dark for light colors).
- **v1.0.0** — Initial release. All 6 steps of `plan.md` built: region capture, annotation editor
  (text/arrow/rectangle), and Notion integration.
