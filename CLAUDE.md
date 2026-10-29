# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

In progress, built step by step from `plan.md` (Steps 1-4 — skeleton/settings, region select,
capture/crop, and the annotation editor — are done; see `bluenest-bugshot/`). Treat `plan.md` as the source of truth for scope, file structure, and step order —
this file only distills the constraints that matter while writing code. The extension is named
**Bluenest Bugshot** (the Chrome-visible name); `plan.md` and code comments may still refer to it by its
working title, "QA Screenshot to Notion."

## What this is

A Manifest V3 Chrome extension for QA testers: select a region of a page, annotate the screenshot
(text/arrow/rectangle), and send it to a Notion database as a new page with auto-filled metadata
(URL, title, browser, OS, viewport, pixel ratio, timestamp). MVP targets internal team use with a
Notion internal integration token — no OAuth, no backend, no Chrome Web Store release (that's Phase 2,
see `plan.md` section 12).

## Development workflow

- No build step. Vanilla JS with ES modules, loaded unpacked via `chrome://extensions` (enable Developer
  Mode → "Load unpacked").
- After any change, reload the extension in `chrome://extensions` and re-check the service worker
  console (the "service worker" link on the extension's card) for errors.
- Build from `plan.md` one numbered step at a time (section 7). Each step has an explicit "Done when"
  checklist — verify it in Chrome before moving to the next step.
- Full manual test checklist lives in `plan.md` section 8; run it after Step 5 and again after Step 6.

## Architecture

```
icon click / keyboard shortcut
        -> background.js (service worker)
             injects content.js + content.css into the active tab
        -> content.js (overlay on the page)
             user drags a selection rectangle, Esc cancels
             sends {x, y, width, height, devicePixelRatio} back to background
        -> background.js
             chrome.tabs.captureVisibleTab (after overlay is removed + a frame delay)
             stores screenshot + rectangle + page metadata
             opens editor.html in a new tab
        -> editor.js (extension page)
             draws screenshot to canvas, crops to rectangle (coords * pixelRatio)
             annotation tools (text, arrow, rectangle) on a separate canvas layer
             flattens both layers on export (JPEG/WebP, max width ~1600px)
        -> notion.js
             creates a Notion file upload, uploads the image
             creates the database page with properties filled in
             attaches the image as a block in the page body
```

## Critical constraints

- **The service worker can be killed at any time.** Never hold flow state (screenshot, rectangle,
  metadata) in module-level/global variables in `background.js`. Pass it through `chrome.storage.session`
  between the capture step and `editor.html`.
- **Overlay must not appear in the screenshot.** `content.js` removes the overlay and waits two
  `requestAnimationFrame`s (to let the removal actually paint) before messaging the background to call
  `captureVisibleTab` — don't send that message synchronously with the DOM removal.
- **Crop math must account for both DPI and zoom.** Multiply selection coordinates by
  `rect.devicePixelRatio` (captured from `window.devicePixelRatio` at selection time) when cropping in
  `editor.js` — this single value already accounts for both retina displays and non-100% browser zoom,
  since Chrome folds zoom into `devicePixelRatio`.
- **A second, separate coordinate transform exists in `editor.js` for annotations.** The annotation
  canvas's internal pixel grid (set to the cropped image's native resolution) is often larger than its
  on-screen CSS size (`max-width: 100%` can shrink it), so pointer events must be rescaled via
  `getCanvasPoint()` before being stored as annotation coordinates — don't use `e.offsetX/offsetY`
  directly. This is independent of the capture-time DPI scaling above.
- **Annotations are data, not pixels, until export.** `editor.js` keeps a plain array of annotation
  objects (`{type, ...}`) redrawn in full on every change (`redraw()`), rather than drawing
  incrementally onto a persistent layer — this is what makes undo a simple array `pop()`. Add new tools
  by adding a case to `drawAnnotation`/`buildShapeDraft`, not by drawing directly in the pointer handlers.
- **Restricted pages (`chrome://`, etc.) are checked before injection**, not just caught as a thrown
  error — `background.js`'s `isRestrictedUrl` short-circuits and shows a `chrome.notifications` toast
  instead of attempting `chrome.scripting.executeScript`, since those pages can't run content scripts at
  all and a caught exception alone isn't a "friendly" user-facing message.
- **Notion property names are centralized.** Keep all Notion database property names/types in one config
  object in `notion.js` (see schema in `plan.md` section 6) so a rename in Notion only requires one
  code change.
- **Token handling.** The Notion integration token lives only in `chrome.storage.local`, set via
  `options.html`. Never hardcode it, never commit it, mask it in the settings UI.
- **Permissions stay minimal.** `activeTab`, `storage`, `scripting`, `notifications`, plus the host
  permission `https://api.notion.com/*` (required for Notion API calls — the one explicit exception to
  avoiding host permissions). `notifications` was added in Step 3, beyond `plan.md` section 3's original
  list, specifically so `background.js` can show a toast for "can't capture this page" — a page a content
  script can't be injected into also can't display an in-page error. Don't add further permissions
  without a similarly concrete reason.
- **`content.js` is a classic (non-module) script re-injected via `chrome.scripting.executeScript` on every
  trigger**, not loaded once. Its whole body must stay wrapped in an IIFE (top-level `let`/`const` would
  throw "already declared" on a second injection in the same page), and it guards against a second
  overlay stacking via a flag on `window`.
- **Manifest V3 only.** Reject any Manifest V2 patterns (e.g. persistent background pages,
  `chrome.extension.*` APIs).
- **Notion API uses the data-source model (API version `2026-03-11`, pinned in `notion.js`).** Since
  the 2025-09-03 breaking change, a database's schema and rows live under a `data_source_id`, not the
  `database_id` directly — `GET /v1/databases/{id}` only returns a `data_sources` array; fetching
  properties or creating pages requires resolving `data_sources[0].id` first via
  `GET /v1/data_sources/{id}`. `notion.js` already does this resolution (see `testConnection`); reuse
  it rather than re-deriving it in Step 5's page-creation flow. Re-check `developers.notion.com` if the
  pinned version is bumped.

## Planned file structure

```
bluenest-bugshot/
  manifest.json
  background.js       # service worker: commands, injection, capture, storage.session handoff
  content.js           # page overlay + drag-to-select
  content.css
  editor.html           # crop + annotate + form (title, severity, notes)
  editor.js
  editor.css
  notion.js             # the only file that talks to the Notion API
  options.html          # token, database ID, reporter name
  options.js
  options.css
  icons/
  .cursor/rules/extension.mdc
  plan.md
```
