# Build Plan: QA Screenshot to Notion Chrome Extension

## 1. Goal

A Chrome extension that lets a QA tester select a region of any web page, annotate the screenshot, and send it to a Notion database as a new card with metadata filled in automatically.

Target for this plan: **internal team version** using a Notion internal integration token. The customer version (OAuth, backend, store release) is covered at the end as a later phase.

## 2. Scope

**In scope (MVP)**
- Trigger by toolbar icon or keyboard shortcut
- Drag to select a region of the visible page
- Crop and preview the screenshot
- Annotate with text, arrow, and rectangle
- Send to a Notion database with auto-filled metadata
- Settings page for Notion token and database ID
- Clear success and error feedback

**Out of scope for MVP**
- Full page (scrolling) screenshots
- Blur or redact tool
- Image paste into the editor
- OAuth, multi-user, Chrome Web Store release
- Video or screen recording

## 3. Tech Decisions

| Decision | Choice | Reason |
|---|---|---|
| Manifest | V3 | Required for new extensions |
| Language | Vanilla JS, ES modules | No build step, faster to debug |
| Annotation | Plain canvas first, library only if needed | Three tools are easy to hand roll |
| Auth | Notion internal integration token in `chrome.storage.local` | No backend needed |
| Image format | JPEG or WebP, max width about 1600px | Keeps uploads small and fast |
| Permissions | `activeTab`, `storage`, `scripting` | Minimal, easier to approve later |
| Host permission | `https://api.notion.com/*` | Needed so the extension can call the Notion API. Required exception to the "no host permissions" rule |

## 4. Architecture

```
User action (icon click or shortcut)
        |
background.js (service worker)
   - receives command
   - injects content.js into the active tab
        |
content.js (overlay on the page)
   - user drags a box
   - sends the selected rectangle back to background
        |
background.js
   - calls captureVisibleTab
   - stores the full screenshot + rectangle + page metadata
   - opens editor.html in a new tab
        |
editor.js (extension page)
   - draws screenshot on canvas, crops to rectangle
   - annotation tools
   - Send button
        |
notion.js
   - creates the page in the database
   - uploads the image
   - attaches the image block
```

Notes:
- The service worker can shut down at any time. Do not keep state in variables. Use `chrome.storage.session` for the capture data passed between steps.
- Captured image data can be large. Prefer storing it as a data URL in `chrome.storage.session`, or pass it to the editor page and keep it there.

## 5. File Structure

```
bluenest-bugshot/
  manifest.json
  background.js
  content.js
  content.css
  editor.html
  editor.js
  editor.css
  notion.js
  options.html
  options.js
  icons/
    16.png
    48.png
    128.png
  .cursor/rules/extension.mdc
  plan.md
```

## 6. Notion Database Schema

Create a database called **QA Pipeline** and share it with your integration. Suggested properties:

| Property | Type | Filled by |
|---|---|---|
| Title | Title | Tester |
| Status | Status or Select | Default "New" |
| Severity | Select (Low, Medium, High, Critical) | Tester |
| Page URL | URL | Auto |
| Page Title | Text | Auto |
| Browser | Text | Auto |
| OS | Text | Auto |
| Viewport | Text | Auto |
| Pixel Ratio | Number | Auto |
| Captured At | Date | Auto |
| Reporter | Text | Settings or tester |
| Notes | Text | Tester |

The screenshot goes into the page body as an image block.

Keep property names in one config object in `notion.js` so a rename in Notion needs only one code change.

## 7. Step-by-Step Build

Each step ends with something you can test in Chrome before moving on. Commit after every passing step.

### Step 1: Skeleton and settings

**Tasks**
- Create `manifest.json` (MV3) with action, commands (keyboard shortcut), options page, service worker, and permissions.
- Add placeholder icons.
- Build `options.html` and `options.js`: fields for Notion token, database ID, and reporter name. Save to and load from `chrome.storage.local`. Mask the token field.
- Add a "Test connection" button that calls the Notion API to read the database and shows success or the error message.
- Load unpacked in `chrome://extensions`.

**Done when**
- Extension loads with no errors.
- Icon click and shortcut both log a message in the service worker console.
- Settings save and reload correctly.
- Test connection succeeds with a valid token and shows a clear error with a bad one.

### Step 2: Region select

**Tasks**
- On trigger, `background.js` injects `content.js` and `content.css` into the active tab.
- `content.js` draws a full-page dim overlay and a crosshair cursor.
- User drags to draw a rectangle. Show the rectangle with a clear border and the dimensions.
- Esc cancels. Releasing the mouse confirms.
- Send the rectangle (x, y, width, height in CSS pixels) plus `window.devicePixelRatio` back to the background.
- Remove the overlay cleanly after use.

**Done when**
- Overlay appears on normal pages, drag works, Esc cancels, overlay is fully removed afterward.
- Works on a page that is scrolled partway down.
- Ignore selections smaller than about 10px.

### Step 3: Capture and crop

**Tasks**
- Background calls `chrome.tabs.captureVisibleTab` after the overlay is removed (wait a frame so the overlay does not appear in the screenshot).
- Open `editor.html` in a new tab and pass the screenshot, rectangle, pixel ratio, and page metadata (URL, title, user agent, viewport size, timestamp).
- In `editor.js`, draw the screenshot to a canvas and crop to the rectangle, multiplying coordinates by the pixel ratio.

**Done when**
- The cropped image in the editor matches exactly what the user selected.
- Correct on a retina display and at browser zoom levels other than 100%.
- Pages like `chrome://extensions` show a friendly "cannot capture this page" message instead of failing silently.

### Step 4: Annotation editor

**Tasks**
- Layout: toolbar on top (select, text, arrow, rectangle, color, undo, clear), canvas in the middle, form at the bottom (title, severity, notes) with Send and Cancel.
- Keep the base screenshot on one canvas and annotations as a list of objects redrawn on a second canvas layer. This makes undo simple.
- Tools:
  - **Text:** click to place, type, Enter to confirm.
  - **Arrow:** drag from start to end, draw a line with an arrowhead.
  - **Rectangle:** drag to draw an outline box.
- Color picker with 4 to 5 preset colors (default red).
- Undo with button and Ctrl/Cmd+Z.
- Export: flatten both layers into one canvas and output as JPEG or WebP.

**Done when**
- All three tools work and can be undone.
- Exported image includes the annotations.
- Image is resized to max width about 1600px and file size is reasonable (target under 1 MB for a typical shot).

### Step 5: Notion integration

**Tasks**
- Build `notion.js` as the only file that talks to Notion.
- Flow:
  1. Create a file upload object with the Notion file upload API.
  2. Send the image data to that upload.
  3. Create a page in the database with all properties filled.
  4. Add the uploaded file as an image block in the page body.
- Check the current Notion docs for the exact endpoints and the required version header, since these can change.
- The Notion API does not allow calls from normal web pages, but extension pages and the service worker can call it because of the `https://api.notion.com/*` host permission.
- Handle errors with readable messages: invalid token, database not shared with the integration, property name mismatch, rate limit (retry after a short delay), network failure.
- After success, show a "Sent" confirmation with a link that opens the new Notion page, then close or reset the editor.

**Done when**
- A card appears in the QA Pipeline database with the screenshot visible inside it and all auto-filled fields correct.
- Each error case above shows a clear message and does not lose the user's annotations.

### Step 6: Polish and real-world testing

**Tasks**
- Disable the Send button while uploading and show a spinner.
- Remember the last severity and reporter name.
- Add a "Copy image to clipboard" button as a fallback.
- Keyboard shortcut hints in the editor.
- Small UI cleanup: spacing, focus states, readable fonts.
- Write a one-page README for the team: how to install, how to set up the token, how to use.

**Done when**
- Two or three teammates install it from the README without help and send real QA cards.

## 8. Test Checklist

Run this after Step 5 and again after Step 6.

**Capture**
- [ ] Normal site, page at top
- [ ] Normal site, scrolled down
- [ ] Browser zoom at 80% and 150%
- [ ] Retina or high DPI display
- [ ] Page with sticky header and fixed elements
- [ ] Page inside an iframe area
- [ ] Dark mode page
- [ ] `chrome://` page (should show friendly error)

**Editor**
- [ ] Each tool works, undo works
- [ ] Very small selection
- [ ] Very large selection (full viewport)
- [ ] Long text annotation

**Notion**
- [ ] Valid setup, card created with image
- [ ] Wrong token
- [ ] Database not shared with the integration
- [ ] Renamed property in Notion
- [ ] Offline or network failure
- [ ] Send twice quickly (should not create duplicates)

**General**
- [ ] No errors in the service worker console
- [ ] Extension still works after Chrome restarts and after the service worker has been idle

## 9. Cursor Workflow

- Keep `.cursor/rules/extension.mdc` in the project.
- Use agent mode one step at a time. Prompt format: "Build Step N from plan.md only. Stop when done and tell me what to reload and test."
- After each step: reload the extension, run the "Done when" checks, paste any console errors back into Cursor, then commit.
- Use a stronger model for Step 3 (crop math) and Step 5 (Notion upload) if the first attempt struggles.

## 10. Risks and Watch Points

| Risk | What to do |
|---|---|
| Service worker goes idle mid-flow | Store flow state in `chrome.storage.session`, never in variables |
| Overlay appears in the screenshot | Remove the overlay and wait a frame before capture |
| Wrong crop on retina or zoomed pages | Multiply by pixel ratio, test on at least two displays |
| AI suggests Manifest V2 code | Reject it and point to the rules file |
| Token exposed | Never hard code it, never commit it, keep the build internal |
| Notion property names drift | Single config object in `notion.js` |
| Large screenshots fail to upload | Resize and compress before upload |

## 11. Timeline

| Day | Work |
|---|---|
| 1 | Step 1 and start Step 2 |
| 2 | Finish Step 2, Step 3 |
| 3 | Step 4 |
| 4 | Step 5 |
| 5 | Step 6, testing with teammates, README |

Estimate assumes one developer using an AI coding tool. Step 4 (annotation) and Step 5 (Notion upload) are the most likely to run over.

## 12. Phase 2 and Beyond

**Team polish**
- Paste or drop an extra image into the annotation
- Blur or redact tool
- Assignee and tags fields
- Full page screenshot (scroll and stitch)
- Capture console errors and network failures as extra metadata

**Customer version**
- Notion OAuth with a small backend to hold the client secret — see section 14, now active work, not deferred
- Duplicable QA database template and field mapping
- Privacy policy, support page, and onboarding flow
- Chrome Web Store listing and review
- Decide support ownership before releasing

## 13. Definition of Done (MVP)

- A tester can go from spotting an issue to a finished Notion card in under 30 seconds.
- Screenshot, annotations, and metadata all arrive correctly.
- Errors are understandable and never lose the tester's work.
- At least three teammates have used it on real QA work without help.

## 14. Team OAuth (Cloudflare Workers)

Replaces the manual "create your own Notion integration, copy the token into Settings" setup (section
2/README) with per-teammate OAuth — each person authorizes with their own Notion login instead of
handling a shared secret. Decided and in progress, not a deferred idea; owner: the person who built this
(single point of contact for the Cloudflare account, the Notion public integration, and anything that
breaks).

**Why this over staying with a shared or per-person internal integration token**
- No static secret living in distributed extension files, Slack messages, or a password manager entry
  someone has to pass around.
- Each teammate's own Notion login is what authorizes — a step toward per-person attribution instead of
  a shared bot identity, even though the Notion card itself still only records the `Reporter` text field
  as before.
- Knowingly accepted tradeoff: Notion OAuth access tokens expire (lifetime undocumented by Notion) and
  refresh tokens rotate on every use, capped at 180 days absolute or 30 days of inactivity — whichever
  comes first. This is not "connect once, forever"; a teammate who stops using the extension for a month
  or more may need to re-authorize. Still strictly better than a shared secret that never expires but can
  leak silently.

**What stays manual no matter what (Notion has no API to automate these)**
1. Registering a *public* Notion integration (not internal) in Notion's developer portal, to get a
   `client_id`/`client_secret` and set an OAuth redirect URI. A human has to do this once, logged into
   the Notion account that should own the integration.
2. Creating the Cloudflare account, authenticating `wrangler`, and creating a KV namespace for token
   storage. Also a one-time setup step, done once by whoever owns this.

**What this removes for everyone else on the team**
- No more teammates creating their own internal integration, hitting the "you don't have permission to
  create internal connections" workspace wall (see the note on this in `CLAUDE.md`), or copying a token
  into Settings by hand.
- Notion's own OAuth consent screen lets the authorizing user pick which pages/databases to grant access
  to as part of approving the connection — expected to fold the separate "share this database with your
  integration" step (section 3) into that single consent screen, rather than requiring it as a second
  manual step afterward. Confirm this during live testing rather than assuming it; Notion's docs weren't
  explicit on this point.

**Architecture**

```
Extension (background.js / new oauth.js)
   - chrome.identity.launchWebAuthFlow() opens Notion's OAuth consent screen
   - redirect_uri is this extension's own chrome.identity.getRedirectURL()
     (https://<extension-id>.chromiumapp.org/) — must be registered exactly
     in the Notion integration's settings
   - gets back an authorization `code`
        |
Cloudflare Worker (new, worker/ in this repo)
   - POST /exchange  {code, installId}
       trades the code for {access_token, refresh_token} using the Notion
       client secret (which never exists in the extension) and stores it
       in Workers KV, keyed by installId
   - GET  /token?installId=...
       returns whatever access_token is currently stored — no proactive
       expiry guessing, since Notion doesn't return an expires_in
   - POST /refresh  {installId}
       uses the stored refresh_token to get a new access_token +
       refresh_token pair from Notion (the old refresh_token is retired by
       Notion on every rotation; the Worker must persist the new one or the
       chain breaks) and updates KV
        |
notion.js (unchanged)
   - still just calls api.notion.com with whatever access_token it's
     handed; doesn't know or care whether it came from a pasted internal
     integration secret or from OAuth
```

`installId` is a random UUID generated once per extension install (`crypto.randomUUID()`), stored in
`chrome.storage.local` — the only thing tying a browser install to its KV record. There's no separate
login system and the Worker never learns who the human is, only this opaque ID.

**Refresh strategy**: reactive, not proactive. The extension asks `/token` for whatever's currently
stored; if a subsequent Notion API call comes back 401, the extension calls `/refresh` once and retries.
Guessing an expiry timer isn't possible since Notion doesn't document the access token's lifetime.

**Manifest changes required**
- New permission: `identity` (for `chrome.identity.launchWebAuthFlow`).
- A host permission (or equivalent awareness) for the Worker's own domain
  (`https://<worker-name>.<account>.workers.dev/*`), since the extension calls it directly.

**Secrets**: `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` are Wrangler secrets on the Worker, never
committed to this repo, never present in the extension.

**Database picker (built on top of OAuth)**: once connected, Settings shows a dropdown listing every
database the connection can see, instead of requiring the database ID to be copied by hand. Built via
Notion's search endpoint filtered to `data_source` objects (the current API version has no "database"
filter value) — each result's `parent.database_id` is the same kind of ID `testConnection`/`sendCapture`
already expect, so this required no changes to how those functions resolve a database, only a new way to
*pick* one. The manual "Database ID" field still exists as an Advanced fallback (e.g. for the
internal-token path, which has no OAuth connection to search with).
