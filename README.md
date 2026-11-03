# Bluenest Bugshot

A Chrome extension for QA testers: select a region of any web page, annotate it, and send it to a Notion
database as a new card — screenshot included, with metadata (page URL, browser, OS, viewport, timestamp)
filled in automatically.

Internal team tool, no Chrome Web Store listing. Connecting to Notion is a one-click OAuth flow backed by
a small Cloudflare Worker (see `plan.md` section 14) — most people reading this only need section 2
below. See [`plan.md`](plan.md) for the full build plan and [`CLAUDE.md`](CLAUDE.md) for architecture
notes if you're developing on it.

## 1. Install

1. Download or `git clone` this repo.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the `bluenest-bugshot/` folder (the one containing `manifest.json`,
   not the repo root).
5. A "Bluenest Bugshot" card should appear, with its icon in your toolbar (pin it via the puzzle-piece
   icon if you don't see it).

## 2. Connect to Notion

This is all most people need to do.

1. Right-click the extension's toolbar icon → **Options** (or **Details** → **Extension options** from
   `chrome://extensions`).
2. Click **Connect to Notion**. A Notion consent screen opens — approve it, and make sure to select the
   **QA Pipeline** database when it asks which pages/databases to share access to.
3. Back in Settings, the **Database** dropdown should now list it — pick it, fill in your name under
   **Reporter**, and click **Save**.
4. Click **Test connection** — you should see "Connected to 'QA Pipeline'. All expected properties
   found."

**No QA database yet?** Under the Database dropdown, open **"Don't have a QA database yet? Create
one"**, pick a Notion page to create it in, and click **Create database**. It comes with every column
Bugshot needs (plus an Assignee column) and is selected and saved automatically. The page list only
shows pages you shared during the Notion consent screen. If it's empty, click **Reconnect** and share a
page too.

If the dropdown says "No databases shared with this connection yet," click **Refresh list** after making
sure you shared QA Pipeline during the consent screen (or share it afterward in Notion: that database's
**"•••"** menu → **Connections** → **Connect to** → find this app's connection).

## 3. Admin setup (already done — one-time, not per-teammate)

Skip this unless you're setting this up for the team for the first time, or something's broken. Full
detail in `plan.md` section 14 and `worker/README.md`.

- A public Notion integration (OAuth, not internal) was registered once, with its redirect URI pinned to
  this extension's fixed ID (`manifest.json`'s `"key"` field makes that ID identical for every install,
  regardless of where someone unzips the extension).
- A Cloudflare Worker (`worker/`) holds the OAuth client secret and each install's token pair — the
  extension never sees the client secret, only short-lived access tokens.
- The **QA Pipeline** database (schema in `plan.md` section 6) was created once, as an inline table
  nested inside a page — not via "+ New page" → "Table" from the sidebar, which can produce a broken
  database with no usable schema (a real Notion bug we hit while building this).

### Fallback: manual internal integration token

If OAuth isn't an option (Worker is down, or you'd rather not depend on it), Settings has an "Advanced"
section for pasting a Notion **internal** integration token and database ID by hand instead — the
original pre-OAuth setup. That path still works but requires creating your own internal integration in
Notion and manually sharing the database with it; see the git history of this README (any commit before
the "Team OAuth" one) for the full walkthrough of that flow.

## 4. Use it

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
   type, Enter to confirm), **↗** (arrow), **▢** (rectangle), the **mosaic icon** (**Blur** — drag over
   something like an email or account ID to pixelate it; this is real pixelation, not a soft blur, so it
   actually destroys the underlying detail), or the **crop icon** (drag to select what to keep, then
   click **Apply Crop** — especially useful after Capture Visible Area or Capture Full Page, since those
   skip region selection entirely and give you the whole thing uncropped) — and a color (ignored by
   Blur/Crop), then draw on the image. Use the **− / +** stepper to set the text size (10–48px) before
   placing a text annotation; it applies to the next one you create, not to text already placed. Undo
   (button or Ctrl/Cmd+Z) reverts the last change, whatever it was — adding a shape, moving one, Clear,
   or a crop; Clear wipes everything (but doesn't undo a crop).
3. Fill in a Title (required), Severity, and Notes.
4. Click **Send**. It uploads the flattened screenshot and creates a card in your QA Pipeline database,
   then shows a link to open it. If you just want the image itself, **Copy Image** copies it to your
   clipboard to paste elsewhere (Slack, docs, etc.) instead.

## Troubleshooting

- **Nothing happens when I click the icon on some pages** — Chrome blocks extensions from capturing its
  own internal pages (`chrome://...`) and the Web Store; you'll get a system notification saying so.
- **Database dropdown is empty or says "No databases shared with this connection yet"** — you didn't
  share the QA Pipeline database during the Notion consent screen. Click **Refresh list**, or share it
  explicitly in Notion first: that database's **"•••"** menu → **Connections** → **Connect to**.
- **"Not connected to Notion. Connect it in Settings first."** — click **Connect to Notion** in Settings;
  this shows if neither an OAuth connection nor a manually pasted token is set up.
- **"Invalid Notion token"** (only relevant if using the manual fallback token) — re-check it in the
  Advanced section; it may have extra whitespace, or the integration was deleted in Notion.
- **"Database not found" / 404** — the database isn't shared with your connection.
- **"This database has no data sources"** — the database was likely created as a top-level page instead
  of an inline table — see the admin setup note above.
- **A property is reported missing** — the name in Notion doesn't match `plan.md` section 6 exactly.
- **Connect to Notion fails or hangs** — the Worker may be down, or the redirect URI mismatched; this is
  admin-level debugging, see `plan.md` section 14 and `worker/README.md`.

## Development

No build step — vanilla JS, loaded unpacked directly. After any code change, reload the extension in
`chrome://extensions` and check the service worker console (the "service worker" link on the extension's
card) for errors. See `CLAUDE.md` for architecture and implementation notes.

## Changelog

- **v1.6.0** — Create the QA database straight from Settings: open "Don't have a QA database yet?
  Create one", pick a Notion page to put it in, and Bugshot creates a database with every column it
  needs and selects it. No more building the schema by hand in Notion. Databases created this way also
  get an **Assignee** (Person) column, assigned in Notion. It's optional, so existing databases without
  it keep working.
- **v1.5.0** — Team OAuth: Settings now has a "Connect to Notion" button backed by a Cloudflare Worker
  (`worker/`), replacing the need for each teammate to create their own Notion integration and copy a
  token by hand. Also added a database picker (dropdown, built on Notion's search API) so the database ID
  doesn't need to be copied manually either — pick it from a list of whatever your connection can see.
  The old manual-token path still works as an Advanced fallback. See `plan.md` section 14 for the full
  architecture and the tradeoffs accepted (this is the project's first backend, and OAuth tokens expire
  and need periodic refresh, unlike the internal token this replaces for most people).
- **v1.4.0** — Added a Blur tool: drag over something sensitive (an email, account ID, etc.) to pixelate
  it. Implemented as real pixelation, not a soft blur — a well-known weak form of redaction that can
  sometimes be partially reversed — so it actually destroys the underlying detail. Works with Move,
  Undo, and Crop like any other annotation.
- **v1.3.0** — Added a Crop tool to the editor: drag to select what to keep, then Apply Crop or Cancel.
  Fully undoable (Ctrl/Cmd+Z reverts a crop like any other change). Mainly closes a gap from v1.2.0 —
  Capture Visible Area and Capture Full Page both skip region selection, so there was previously no way
  to trim them down before sending.
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
