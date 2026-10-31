# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

MVP complete (all 6 steps of `plan.md`) plus several post-MVP additions: a Move tool, a real undo
history, adjustable text size, an in-editor Crop tool, a Chrome best-practices hardening pass, and two
more capture modes — visible-area and full-page — beyond the original region-select-only scope. Note
that full-page capture was explicitly listed as "out of scope for MVP" in `plan.md` section 2; it's since
been added anyway at the user's request, so treat `plan.md` as the historical starting scope, not the
current feature ceiling. This file documents the as-built state. The extension is named **Bluenest Bugshot** (the Chrome-visible
name); `plan.md` and code comments may still refer to it by its working title, "QA Screenshot to Notion."

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

This diagram shows region-select (the icon click / `capture-region` shortcut). Two more trigger paths — the
`capture-visible`/`capture-fullpage` keyboard shortcuts and the toolbar icon's right-click menu
(`chrome.contextMenus`) — converge onto the *same* `handleRegionSelected()` → `chrome.storage.session` →
`editor.html` tail as region-select, just with a different `rect`:
- **Visible area** (`captureVisibleOnly`): measures the viewport via `chrome.scripting.executeScript`'s
  `func:` form (no content script injection needed for a one-off value read), then calls
  `handleRegionSelected` with a rect spanning the whole viewport — no new capture logic at all.
- **Full page** (`captureFullPage`): scrolls in viewport-height increments (`scrollTabTo`), capturing each
  screen 600ms apart with quota-retry (`captureVisibleTabWithRetry`, since `captureVisibleTab` is
  hard-capped at 2 calls/sec), stitches them with `OffscreenCanvas`/`createImageBitmap` — natively
  available in MV3 service workers, no DOM needed — into one JPEG, then calls `handleRegionSelected` with
  a `precomputedDataUrl` so it skips its own `captureVisibleTab` call. Capped at
  `FULL_PAGE_MAX_SHOTS` (25) and `FULL_PAGE_MAX_HEIGHT_PX` (30000, to stay under Chrome's canvas size
  limit), whichever is smaller, with a notification if a page gets truncated. **Known limitation, not a
  bug to fix casually:** fixed/sticky elements (headers, cookie banners) appear once per captured screen,
  so they're duplicated at each stitch seam — detecting and hiding them during capture would fix this but
  is real added complexity, and every basic scroll-and-stitch tool has this same limitation.

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
- **Anything sized in canvas-internal pixels that must visually match something sized in CSS pixels
  needs `getCanvasScale()`, not `devicePixelRatio`.** The text tool's annotation font size and position
  previously used `devicePixelRatio` directly and drifted badly from the `.annotation-text-input`
  overlay's actual CSS size/position — `devicePixelRatio` only accounts for retina scaling, not the
  *additional* shrink from `max-width: 100%` on a capture wider than the container. `getCanvasScale()`
  (`canvas.width / boundingClientRect.width`) is the real canvas-px-per-CSS-px ratio at render time;
  `TEXT_INPUT_INSET_X_CSS`/`_INSET_Y_CSS` must stay in sync with `.annotation-text-input`'s actual
  border/padding in `editor.css` if either changes.
- **Text size is adjustable (10–48px CSS, via `FONT_SIZE_MIN_CSS`/`_MAX_CSS`/`_STEP_CSS`), applied to
  the *next* text annotation created — same "current setting" pattern as `currentColor`, not a per-shape
  property editor.** `openTextInput` freezes `currentFontSizeCss` into a local `fontSizeAtOpen` at the
  moment the input is created, and uses that same frozen value for both the input's own `font-size` and
  the eventual committed annotation's `fontSize` — this is deliberate, so a user clicking the stepper
  again while an input is still open can't make the committed text silently different from what they saw
  while typing. `currentColor` doesn't have this same freeze and *can* drift in that scenario; don't
  treat that as a precedent to copy if touching color next — fix it the same way instead.
- **Annotations are data, not pixels, until export.** `editor.js` keeps a plain array of annotation
  objects (`{type, ...}`) redrawn in full on every change (`redraw()`), rather than drawing
  incrementally onto a persistent layer. Add new tools by adding a case to
  `drawAnnotation`/`buildShapeDraft`, not by drawing directly in the pointer handlers.
- **Undo is a snapshot history, not `annotations.pop()`.** An earlier version just popped the array,
  which "undid" a move by deleting the moved shape entirely instead of reverting its position — wrong.
  `pushHistory()` snapshots the *whole* `annotations` array immediately before any change (adding a
  shape, starting a move, clearing), and `undo()` restores the last snapshot wholesale. Every mutation
  site must call `pushHistory()` first — a move's snapshot is taken at `pointerdown` (before
  `translateAnnotation` touches anything) and discarded by `cancelMove()` if Esc cancels it, since
  nothing actually changed. If you add a new kind of mutation, give it the same treatment.
  Dragging itself (`hitTest()` finds the shape; `translateAnnotation()` recomputes position from the
  *original* snapshot plus total pointer delta each `pointermove`, not accumulated per-frame deltas,
  which would drift) doesn't call `pushHistory()` on every frame — only once, at drag start.
- **History snapshots `{annotations, cropRect}` together, not just `annotations`.** This is what lets
  Undo revert a Crop (restoring both the annotation positions *and* the previous view into the image) the
  same way it reverts anything else — don't add a parallel undo mechanism for crop specifically.
- **Cropping never mutates the originally-loaded image.** `originalImage` (the `Image` object from
  `init()`) is decoded once and kept around; `cropRect` is just "what part of `originalImage`, in its
  device-pixel space, is currently shown" — `renderBase()` redraws `baseCanvas`/`annotationCanvas` from
  it at any time, which is both how the initial load renders and how every crop/undo re-renders. Applying
  a new crop *composes* the dragged rect (in current-canvas-local space, i.e. the same space as
  annotation coordinates) onto `cropRect` (which is in `originalImage` space) — `newCropRect = {x:
  cropRect.x + rect.x, y: cropRect.y + rect.y, width: rect.width, height: rect.height}` — rather than
  replacing it, so nested crops (crop, then crop the result again) and undo both work without tracking a
  separate transform chain. Existing annotations are translated by `-rect.x, -rect.y` into the new crop's
  local space at the same time; any that no longer overlap the new bounds are dropped
  (`annotationOverlapsBounds`) rather than kept invisible forever.
- **The crop preview dims the four strips *around* the selection, not a clear+cutout.** Clearing the
  kept rectangle would also erase any annotations already drawn there earlier in the same `redraw()`
  call; four separate `fillRect` strips (top/bottom/left/right of the selection) never touch those pixels.
- **Hit-test tolerance scales with the capture's resolution** (`annotationCanvas.width * 0.01`, same
  pattern as the relative stroke widths in `drawRect`/`drawArrow`), so grabbing a thin line feels
  consistent whether the screenshot is small or large — don't hardcode a fixed pixel tolerance.
- **Restricted pages (`chrome://`, etc.) are checked before injection**, not just caught as a thrown
  error — `background.js`'s `isRestrictedUrl` short-circuits and shows a `chrome.notifications` toast
  instead of attempting `chrome.scripting.executeScript`, since those pages can't run content scripts at
  all and a caught exception alone isn't a "friendly" user-facing message.
- **Notion property names are centralized.** Keep all Notion database property names/types in one config
  object in `notion.js` (see schema in `plan.md` section 6) so a rename in Notion only requires one
  code change.
- **Token handling.** The Notion integration token lives only in `chrome.storage.local`, set via
  `options.html`. Never hardcode it, never commit it, mask it in the settings UI.
- **Permissions stay minimal.** `activeTab`, `storage`, `scripting`, `notifications`, `contextMenus`, plus
  the host permission `https://api.notion.com/*` (required for Notion API calls — the one explicit
  exception to avoiding host permissions). `notifications` was added in Step 3, beyond `plan.md` section
  3's original list, specifically so `background.js` can show a toast for "can't capture this page" — a
  page a content script can't be injected into also can't display an in-page error. `contextMenus` was
  added for the visible-area/full-page capture modes' right-click trigger. Don't add further permissions
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
  `GET /v1/data_sources/{id}`. Both `testConnection` and `sendCapture` share this resolution via
  `resolveDatabase()` — don't re-derive it elsewhere. Re-check `developers.notion.com` if the pinned
  version is bumped.
- **Notion page creation builds property values from the live schema's types, not hardcoded
  assumptions.** `sendCapture` reads each property's actual `type` (title/rich_text/url/number/date/
  select/status) from the resolved data source and dispatches through `buildPropertyValue` — this is
  specifically so a "Status" property can be either a Status-type or Select-type column (plan.md section
  6 allows either) without special-casing it. Add a new mapped field by adding it to `NOTION_PROPERTIES`
  and `buildPropertyValue`'s `fieldValues`, not by hand-building its JSON shape at the call site.
- **Sending refuses to run with missing properties rather than partially succeeding.** `sendCapture`
  checks for the same missing-properties condition `testConnection` reports, and throws before
  uploading anything if any are missing — this avoids creating a page with a blank title (or similar)
  when a property was silently skipped. Don't change this to skip-and-continue.
- **The file upload flow is two calls, not one.** `POST /v1/file_uploads` creates the upload object
  (JSON body: mode/filename/content_type); the actual bytes go to the *fixed* endpoint
  `POST /v1/file_uploads/{id}/send` as `multipart/form-data` with a `file` field — never the `upload_url`
  from the create response. The `Content-Type` header must be omitted (not set to anything) on that
  second call so `fetch` can generate the multipart boundary itself.
- **Send is guarded against double-submit.** `editor.js` disables `sendButton` synchronously inside the
  submit handler, before any `await`, and only re-enables it on failure — never in a `finally`. This is
  what makes "send twice quickly" not create duplicate Notion pages (see `plan.md` section 8's test
  checklist).
- **The clipboard-copy export is PNG, not the JPEG used for the Notion upload.** The Async Clipboard API
  only reliably supports `image/png` in a `ClipboardItem` — `image/jpeg` isn't broadly readable by other
  apps pasting from the clipboard. `editor.js`'s `exportForClipboard()` is a separate, uncompressed,
  non-resized flatten from `exportFlattenedImage()`; don't merge them to "avoid duplication."
- **Explicit CSP, request timeouts, and message validation are deliberate hardening, not defaults to
  relax.** Following a best-practices audit: `manifest.json` declares `content_security_policy` explicitly
  (`script-src 'self'; object-src 'self'`) rather than relying on MV3's implicit default, even though
  they're currently identical. `notion.js`'s `requestWithRetry` wraps every call in a 20s
  `AbortController` timeout (`fetchWithTimeout`) so a hung connection can't leave `editor.js`'s Send flow
  stuck on "Uploading…" forever. `background.js`'s `runtime.onMessage` listener checks
  `sender.id === chrome.runtime.id` before anything else (defense in depth — nothing external can reach
  it today, since there's no `externally_connectable`, but don't assume that stays true if the manifest
  changes), and `handleRegionSelected` validates `message.rect`'s shape (`isValidRect`) before trusting
  it, rather than passing a possibly-malformed rect through to `editor.js`'s crop math.

## File structure

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
```

(`plan.md`, `CLAUDE.md`, and `README.md` live at the repo root, one level up from this folder.)
