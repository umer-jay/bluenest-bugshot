import { sendCapture } from "./notion.js";

const MAX_EXPORT_WIDTH = 1600;
const EXPORT_QUALITY = 0.85;

// The text input's border + padding (border 1px + padding-left 4px
// horizontally, border 1px + padding-top 2px vertically) — needed so
// committed text lands at the same position as what was actually typed.
// Its font-size is adjustable (see the size stepper below), applied
// per-instance in JS rather than fixed in CSS.
const TEXT_INPUT_INSET_X_CSS = 5;
const TEXT_INPUT_INSET_Y_CSS = 3;

const FONT_SIZE_MIN_CSS = 10;
const FONT_SIZE_MAX_CSS = 48;
const FONT_SIZE_STEP_CSS = 2;
const FONT_SIZE_DEFAULT_CSS = 16;

const MIN_CROP_SIZE = 10;

const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const toolbarEl = document.getElementById("toolbar");
const canvasStack = document.getElementById("canvas-stack");
const baseCanvas = document.getElementById("base-canvas");
const annotationCanvas = document.getElementById("annotation-canvas");
const actx = annotationCanvas.getContext("2d");
const detailsForm = document.getElementById("details-form");
const titleInput = document.getElementById("title-input");
const severitySelect = document.getElementById("severity-select");
const notesTextarea = document.getElementById("notes-textarea");
const sendButton = document.getElementById("send-button");
const sendSpinner = document.getElementById("send-spinner");
const sendLabel = document.getElementById("send-label");
const copyButton = document.getElementById("copy-button");
const cancelButton = document.getElementById("cancel-button");
const statusEl = document.getElementById("status");
const undoButton = document.getElementById("undo-button");
const clearButton = document.getElementById("clear-button");
const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
const colorButtons = Array.from(document.querySelectorAll(".color-swatch"));
const fontSizeDisplay = document.getElementById("font-size-display");
const fontSizeDecreaseBtn = document.getElementById("font-size-decrease");
const fontSizeIncreaseBtn = document.getElementById("font-size-increase");
const cropActionsEl = document.getElementById("crop-actions");
const applyCropButton = document.getElementById("apply-crop-button");
const cancelCropButton = document.getElementById("cancel-crop-button");

let captureRect = null;
let capturePageMeta = null;
let originalImage = null; // the loaded, never-mutated Image; cropping just redraws from it
// The current "view" into originalImage, in its device-pixel coordinate
// space — {x, y, width, height}. Starts as the full captured rect; each
// applied crop narrows it further (composed relative to this, not to
// whatever the previous crop already showed).
let cropRect = null;
let annotations = [];
// Snapshots of {annotations, cropRect} taken right before each change (add,
// move, clear, crop) — undo restores both wholesale, so it reverts ANY
// change, not just "remove the most recently added shape."
let history = [];
let draft = null;
let dragStart = null;
let movingIndex = -1;
let moveStart = null;
let moveOriginal = null;
let cropDraft = null; // live preview while dragging a new crop selection
let pendingCrop = null; // confirmed drag, awaiting Apply/Cancel
let currentTool = "select";
let currentColor = "#dc2626";
let currentFontSizeCss = FONT_SIZE_DEFAULT_CSS;

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  toolbarEl.hidden = true;
  canvasStack.hidden = true;
  detailsForm.hidden = true;
  metaEl.hidden = true;
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error");
  if (kind) statusEl.classList.add(kind);
}

function setStatusWithLink(message, url, linkText) {
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  statusEl.classList.add("success");
  statusEl.appendChild(document.createTextNode(`${message} `));
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = linkText;
  statusEl.appendChild(link);
}

// --- Coordinate conversion -------------------------------------------------
// The canvas's internal pixel grid (its width/height attributes) can be
// larger than its on-screen CSS size once `max-width: 100%` kicks in, so
// pointer coordinates must be rescaled into canvas space.

function getCanvasPoint(e) {
  const domRect = annotationCanvas.getBoundingClientRect();
  const scaleX = annotationCanvas.width / domRect.width;
  const scaleY = annotationCanvas.height / domRect.height;
  return {
    x: (e.clientX - domRect.left) * scaleX,
    y: (e.clientY - domRect.top) * scaleY,
  };
}

function canvasPointToCss(point) {
  const domRect = annotationCanvas.getBoundingClientRect();
  const scaleX = domRect.width / annotationCanvas.width;
  const scaleY = domRect.height / annotationCanvas.height;
  return { left: point.x * scaleX, top: point.y * scaleY };
}

// How many canvas-internal pixels correspond to one on-screen CSS pixel
// right now. Needed for anything sized in canvas space (like committed text)
// that has to visually match something sized in CSS space (like the text
// input overlay) — devicePixelRatio alone isn't enough once the canvas is
// also shrunk by `max-width: 100%`.
function getCanvasScale() {
  const domRect = annotationCanvas.getBoundingClientRect();
  return annotationCanvas.width / domRect.width;
}

// --- Drawing -----------------------------------------------------------

function drawRect(ctx2d, ann) {
  ctx2d.strokeStyle = ann.color;
  ctx2d.lineWidth = Math.max(2, annotationCanvas.width * 0.003);
  ctx2d.strokeRect(ann.x, ann.y, ann.width, ann.height);
}

function drawArrow(ctx2d, ann) {
  const headLength = Math.max(10, annotationCanvas.width * 0.015);
  const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
  ctx2d.strokeStyle = ann.color;
  ctx2d.fillStyle = ann.color;
  ctx2d.lineWidth = Math.max(2, annotationCanvas.width * 0.003);

  ctx2d.beginPath();
  ctx2d.moveTo(ann.x1, ann.y1);
  ctx2d.lineTo(ann.x2, ann.y2);
  ctx2d.stroke();

  ctx2d.beginPath();
  ctx2d.moveTo(ann.x2, ann.y2);
  ctx2d.lineTo(
    ann.x2 - headLength * Math.cos(angle - Math.PI / 6),
    ann.y2 - headLength * Math.sin(angle - Math.PI / 6)
  );
  ctx2d.lineTo(
    ann.x2 - headLength * Math.cos(angle + Math.PI / 6),
    ann.y2 - headLength * Math.sin(angle + Math.PI / 6)
  );
  ctx2d.closePath();
  ctx2d.fill();
}

function drawText(ctx2d, ann) {
  ctx2d.fillStyle = ann.color;
  ctx2d.font = `600 ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx2d.textBaseline = "top";
  ctx2d.fillText(ann.text, ann.x, ann.y);
}

// Pixelation, not a soft blur: downscale the region to a tiny canvas (which
// discards the fine detail via the browser's own downsampling), then draw
// that back up at full size with smoothing off. This is deliberately chosen
// over a Gaussian blur, which is a well-known weak form of redaction that
// can sometimes be partially reversed — pixelation at a block size this
// large genuinely destroys the underlying detail.
function drawBlur(ctx2d, ann) {
  const sx = Math.round(ann.x);
  const sy = Math.round(ann.y);
  const sw = Math.round(ann.width);
  const sh = Math.round(ann.height);
  if (sw <= 0 || sh <= 0) return;

  const blockSize = Math.max(6, Math.round(annotationCanvas.width * 0.012));
  const smallW = Math.max(1, Math.round(sw / blockSize));
  const smallH = Math.max(1, Math.round(sh / blockSize));

  const tmp = document.createElement("canvas");
  tmp.width = smallW;
  tmp.height = smallH;
  tmp.getContext("2d").drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, smallW, smallH);

  ctx2d.save();
  ctx2d.imageSmoothingEnabled = false;
  ctx2d.drawImage(tmp, 0, 0, smallW, smallH, sx, sy, sw, sh);
  ctx2d.restore();
}

function drawAnnotation(ctx2d, ann) {
  if (ann.type === "rect") drawRect(ctx2d, ann);
  else if (ann.type === "arrow") drawArrow(ctx2d, ann);
  else if (ann.type === "text") drawText(ctx2d, ann);
  else if (ann.type === "blur") drawBlur(ctx2d, ann);
}

// Dims everything outside `rect` (via four surrounding strips, not a
// clear+cutout, so existing annotations drawn earlier in this same redraw()
// stay fully visible inside the kept region instead of being wiped too).
function drawCropOverlay(ctx2d, rect) {
  const w = annotationCanvas.width;
  const h = annotationCanvas.height;
  ctx2d.save();
  ctx2d.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx2d.fillRect(0, 0, w, rect.y);
  ctx2d.fillRect(0, rect.y + rect.height, w, h - (rect.y + rect.height));
  ctx2d.fillRect(0, rect.y, rect.x, rect.height);
  ctx2d.fillRect(rect.x + rect.width, rect.y, w - (rect.x + rect.width), rect.height);

  ctx2d.strokeStyle = "#2563eb";
  ctx2d.lineWidth = Math.max(2, w * 0.003);
  ctx2d.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx2d.restore();
}

function drawSelectionHighlight(ctx2d, ann) {
  const bounds = getAnnotationBounds(ann);
  const pad = Math.max(4, annotationCanvas.width * 0.006);
  ctx2d.save();
  ctx2d.strokeStyle = "#2563eb";
  ctx2d.lineWidth = Math.max(1.5, annotationCanvas.width * 0.002);
  ctx2d.setLineDash([Math.max(4, annotationCanvas.width * 0.006), Math.max(3, annotationCanvas.width * 0.004)]);
  ctx2d.strokeRect(bounds.x - pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);
  ctx2d.restore();
}

function redraw() {
  actx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  for (const ann of annotations) drawAnnotation(actx, ann);
  if (draft) drawAnnotation(actx, draft);
  if (movingIndex !== -1 && annotations[movingIndex]) {
    drawSelectionHighlight(actx, annotations[movingIndex]);
  }
  const cropPreview = cropDraft || pendingCrop;
  if (cropPreview) drawCropOverlay(actx, cropPreview);
}

// Redraws the base image from the original (untouched) Image at the current
// cropRect, resizing both canvases to match. This is how both the initial
// load and every applied/undone crop render — cropping never mutates
// originalImage, just what part of it is shown.
function renderBase() {
  baseCanvas.width = cropRect.width;
  baseCanvas.height = cropRect.height;
  baseCanvas
    .getContext("2d")
    .drawImage(
      originalImage,
      cropRect.x,
      cropRect.y,
      cropRect.width,
      cropRect.height,
      0,
      0,
      cropRect.width,
      cropRect.height
    );
  annotationCanvas.width = cropRect.width;
  annotationCanvas.height = cropRect.height;
  if (capturePageMeta) {
    metaEl.textContent =
      `${capturePageMeta.title} — ${capturePageMeta.url} — ` +
      `${cropRect.width}×${cropRect.height}px (pixel ratio ${captureRect.devicePixelRatio})`;
  }
  redraw();
}

// --- Move tool: hit-testing and repositioning ---------------------------

function getAnnotationBounds(ann) {
  if (ann.type === "rect" || ann.type === "blur") {
    return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
  }
  if (ann.type === "arrow") {
    return {
      x: Math.min(ann.x1, ann.x2),
      y: Math.min(ann.y1, ann.y2),
      width: Math.abs(ann.x2 - ann.x1),
      height: Math.abs(ann.y2 - ann.y1),
    };
  }
  // text
  actx.font = `600 ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  return { x: ann.x, y: ann.y, width: actx.measureText(ann.text).width, height: ann.fontSize * 1.2 };
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Returns the index of the topmost annotation under `point`, or -1.
// Hit tolerance scales with the capture's resolution so it feels
// consistent whether the screenshot is small or large.
function hitTest(point) {
  const tolerance = Math.max(8, annotationCanvas.width * 0.01);
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (ann.type === "arrow") {
      if (distanceToSegment(point.x, point.y, ann.x1, ann.y1, ann.x2, ann.y2) <= tolerance) return i;
      continue;
    }
    const b = getAnnotationBounds(ann);
    if (
      point.x >= b.x - tolerance &&
      point.x <= b.x + b.width + tolerance &&
      point.y >= b.y - tolerance &&
      point.y <= b.y + b.height + tolerance
    ) {
      return i;
    }
  }
  return -1;
}

function translateAnnotation(ann, dx, dy) {
  if (ann.type === "arrow") {
    return { ...ann, x1: ann.x1 + dx, y1: ann.y1 + dy, x2: ann.x2 + dx, y2: ann.y2 + dy };
  }
  return { ...ann, x: ann.x + dx, y: ann.y + dy };
}

// --- Crop tool -----------------------------------------------------------

// Rounded: getCanvasPoint() produces fractional coordinates (it scales by a
// floating-point display-to-canvas ratio), and this rect ends up assigned
// straight to canvas.width/height — a fractional value there gets silently
// truncated by the browser, but cropRect (the JS-side record of "what's
// currently shown") would keep the fraction, drifting out of sync with the
// canvas's actual pixel dimensions and showing up as ugly numbers in the UI.
function rectFromPoints(start, end) {
  return {
    x: Math.round(Math.min(start.x, end.x)),
    y: Math.round(Math.min(start.y, end.y)),
    width: Math.round(Math.abs(end.x - start.x)),
    height: Math.round(Math.abs(end.y - start.y)),
  };
}

function annotationOverlapsBounds(ann, width, height) {
  const b = getAnnotationBounds(ann);
  return b.x + b.width > 0 && b.x < width && b.y + b.height > 0 && b.y < height;
}

function updateCropButtonsVisibility() {
  cropActionsEl.hidden = !pendingCrop;
}

// `rect` is in CURRENT-canvas-local space (same space as annotation
// coordinates) — composing it into cropRect (which is in originalImage
// space) is what lets nested crops and undo work without tracking a
// separate transform chain.
function applyCrop(rect) {
  pushHistory();

  annotations = annotations
    .map((a) => translateAnnotation(a, -rect.x, -rect.y))
    .filter((a) => annotationOverlapsBounds(a, rect.width, rect.height));

  cropRect = {
    x: cropRect.x + rect.x,
    y: cropRect.y + rect.y,
    width: rect.width,
    height: rect.height,
  };

  renderBase();
}

// --- Tools and color ------------------------------------------------------

function setTool(tool) {
  if (pendingCrop && tool !== "crop") {
    cancelPendingCrop();
  }
  currentTool = tool;
  for (const btn of toolButtons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.tool === tool));
  }
  annotationCanvas.style.cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : tool === "move" ? "move" : "crosshair";
}

function setColor(color) {
  currentColor = color;
  for (const btn of colorButtons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.color === color));
  }
}

// Applies to the next text annotation created, not to text already placed —
// same as how currentColor only affects new shapes.
function setFontSize(size) {
  currentFontSizeCss = Math.min(FONT_SIZE_MAX_CSS, Math.max(FONT_SIZE_MIN_CSS, size));
  fontSizeDisplay.textContent = `${currentFontSizeCss}px`;
  fontSizeDecreaseBtn.disabled = currentFontSizeCss <= FONT_SIZE_MIN_CSS;
  fontSizeIncreaseBtn.disabled = currentFontSizeCss >= FONT_SIZE_MAX_CSS;
}

fontSizeDecreaseBtn.addEventListener("click", () => setFontSize(currentFontSizeCss - FONT_SIZE_STEP_CSS));
fontSizeIncreaseBtn.addEventListener("click", () => setFontSize(currentFontSizeCss + FONT_SIZE_STEP_CSS));
setFontSize(currentFontSizeCss);

toolButtons.forEach((btn) => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
colorButtons.forEach((btn) => btn.addEventListener("click", () => setColor(btn.dataset.color)));

// --- Rectangle / arrow drag -------------------------------------------

function buildShapeDraft(start, end) {
  if (currentTool === "rect" || currentTool === "blur") {
    return {
      type: currentTool,
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      ...(currentTool === "rect" ? { color: currentColor } : {}),
    };
  }
  if (currentTool === "arrow") {
    return { type: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: currentColor };
  }
  return null;
}

function shapeIsEmpty(shape) {
  if (!shape) return true;
  if (shape.type === "rect" || shape.type === "blur") return shape.width < 2 || shape.height < 2;
  if (shape.type === "arrow") {
    return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 2;
  }
  return false;
}

function onPointerDown(e) {
  if (currentTool === "select") return;
  const point = getCanvasPoint(e);

  if (currentTool === "text") {
    openTextInput(point);
    return;
  }

  if (currentTool === "move") {
    const index = hitTest(point);
    if (index === -1) return;
    pushHistory();
    movingIndex = index;
    moveStart = point;
    moveOriginal = annotations[index];
    annotationCanvas.setPointerCapture(e.pointerId);
    return;
  }

  dragStart = point;
  annotationCanvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (movingIndex !== -1) {
    const point = getCanvasPoint(e);
    annotations[movingIndex] = translateAnnotation(
      moveOriginal,
      point.x - moveStart.x,
      point.y - moveStart.y
    );
    redraw();
    return;
  }
  if (!dragStart) return;
  if (currentTool === "crop") {
    cropDraft = rectFromPoints(dragStart, getCanvasPoint(e));
    redraw();
    return;
  }
  draft = buildShapeDraft(dragStart, getCanvasPoint(e));
  redraw();
}

function onPointerUp(e) {
  if (movingIndex !== -1) {
    movingIndex = -1;
    moveStart = null;
    moveOriginal = null;
    redraw();
    return;
  }
  if (!dragStart) return;

  if (currentTool === "crop") {
    const rect = rectFromPoints(dragStart, getCanvasPoint(e));
    dragStart = null;
    cropDraft = null;
    if (rect.width >= MIN_CROP_SIZE && rect.height >= MIN_CROP_SIZE) {
      pendingCrop = rect;
      updateCropButtonsVisibility();
    }
    redraw();
    return;
  }

  const shape = buildShapeDraft(dragStart, getCanvasPoint(e));
  dragStart = null;
  draft = null;

  if (!shapeIsEmpty(shape)) {
    pushHistory();
    annotations.push(shape);
  }
  redraw();
}

function cancelMove() {
  if (movingIndex === -1) return;
  annotations[movingIndex] = moveOriginal;
  movingIndex = -1;
  moveStart = null;
  moveOriginal = null;
  // Nothing actually changed, so drop the snapshot pushHistory() took when
  // the drag started — otherwise Ctrl/Cmd+Z would restore an identical state.
  history.pop();
  redraw();
}

annotationCanvas.addEventListener("pointerdown", onPointerDown);
annotationCanvas.addEventListener("pointermove", onPointerMove);
annotationCanvas.addEventListener("pointerup", onPointerUp);

// --- Text tool --------------------------------------------------------

function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 200;
}

function openTextInput(canvasPoint) {
  const { left, top } = canvasPointToCss(canvasPoint);
  const scale = getCanvasScale();
  // Frozen at creation time so the committed text always matches exactly
  // what was shown while typing, even if the size stepper is clicked
  // again before this input is confirmed.
  const fontSizeAtOpen = currentFontSizeCss;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "annotation-text-input";
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  input.style.fontSize = `${fontSizeAtOpen}px`;
  input.style.color = currentColor;
  // The input's default background is light, so a light annotation color
  // (white) would be invisible while typing — swap to a dark background
  // for light colors so the typed text stays readable.
  if (isLightColor(currentColor)) {
    input.style.background = "rgba(17, 24, 39, 0.92)";
  }
  canvasStack.appendChild(input);
  // The canvas's own default mousedown handling steals focus back if we
  // call .focus() synchronously here, so the input would blur (and commit
  // empty) before the user can type anything. Deferring to the next tick
  // lets that default behavior finish first.
  setTimeout(() => input.focus(), 0);

  let settled = false;

  function commit() {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    input.remove();
    if (!value) return;
    pushHistory();
    annotations.push({
      type: "text",
      x: canvasPoint.x + TEXT_INPUT_INSET_X_CSS * scale,
      y: canvasPoint.y + TEXT_INPUT_INSET_Y_CSS * scale,
      text: value,
      color: currentColor,
      fontSize: Math.round(fontSizeAtOpen * scale),
    });
    redraw();
  }

  function cancelInput() {
    if (settled) return;
    settled = true;
    input.remove();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelInput();
    }
  });
  input.addEventListener("blur", commit);
}

// --- Undo / clear -------------------------------------------------------

function pushHistory() {
  history.push({
    annotations: annotations.map((a) => ({ ...a })),
    cropRect: { ...cropRect },
  });
}

function undo() {
  if (history.length === 0) return;
  const snapshot = history.pop();
  annotations = snapshot.annotations;
  cropRect = snapshot.cropRect;
  renderBase();
}

function clearAll() {
  if (annotations.length === 0) return;
  pushHistory();
  annotations = [];
  redraw();
}

undoButton.addEventListener("click", undo);
clearButton.addEventListener("click", clearAll);

function cancelPendingCrop() {
  pendingCrop = null;
  updateCropButtonsVisibility();
  redraw();
}

applyCropButton.addEventListener("click", () => {
  if (!pendingCrop) return;
  const rect = pendingCrop;
  pendingCrop = null;
  updateCropButtonsVisibility();
  applyCrop(rect);
  setTool("select");
});

cancelCropButton.addEventListener("click", cancelPendingCrop);

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "Escape") {
    if (movingIndex !== -1) {
      e.preventDefault();
      cancelMove();
    } else if (pendingCrop) {
      e.preventDefault();
      cancelPendingCrop();
    }
  }
});

// --- Export -------------------------------------------------------------

function flattenToBlob(targetWidth, targetHeight, mimeType, quality) {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = targetWidth;
  exportCanvas.height = targetHeight;
  const exportCtx = exportCanvas.getContext("2d");
  exportCtx.drawImage(baseCanvas, 0, 0, targetWidth, targetHeight);
  exportCtx.drawImage(annotationCanvas, 0, 0, targetWidth, targetHeight);
  return new Promise((resolve) => exportCanvas.toBlob(resolve, mimeType, quality));
}

async function exportFlattenedImage() {
  const sourceWidth = baseCanvas.width;
  const sourceHeight = baseCanvas.height;
  const scale = Math.min(1, MAX_EXPORT_WIDTH / sourceWidth);
  const targetWidth = Math.round(sourceWidth * scale);
  const targetHeight = Math.round(sourceHeight * scale);
  const blob = await flattenToBlob(targetWidth, targetHeight, "image/jpeg", EXPORT_QUALITY);
  return { blob, width: targetWidth, height: targetHeight };
}

// The clipboard's Async Clipboard API only reliably supports image/png for
// ClipboardItem.write — image/jpeg isn't broadly readable by other apps —
// so this is a separate, uncompressed export rather than reusing the JPEG
// path meant for the Notion upload.
async function exportForClipboard() {
  return flattenToBlob(baseCanvas.width, baseCanvas.height, "image/png");
}

function setSending(isSending) {
  sendButton.disabled = isSending;
  sendSpinner.hidden = !isSending;
  sendLabel.textContent = isSending ? "Sending…" : "Send";
  copyButton.disabled = isSending;
}

detailsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  // Disabled immediately and only re-enabled on failure, so a double-click
  // or a second Enter press can't fire a duplicate send while one is
  // already in flight or after one has already succeeded.
  setSending(true);
  cancelButton.disabled = true;

  try {
    const { notionToken, notionDatabaseId, reporterName } = await chrome.storage.local.get([
      "notionToken",
      "notionDatabaseId",
      "reporterName",
    ]);

    if (!notionToken || !notionDatabaseId) {
      throw new Error(
        "Set up your Notion token and database ID in Settings first (right-click the extension icon → Options)."
      );
    }

    setStatus("Exporting…");
    const { blob } = await exportFlattenedImage();

    setStatus("Uploading to Notion…");
    const { pageUrl } = await sendCapture({
      token: notionToken,
      databaseId: notionDatabaseId,
      blob,
      title: titleInput.value.trim(),
      severity: severitySelect.value,
      notes: notesTextarea.value.trim(),
      reporter: reporterName || "",
      pageMeta: capturePageMeta,
      devicePixelRatio: captureRect.devicePixelRatio,
    });

    await chrome.storage.local.set({ lastSeverity: severitySelect.value });

    setStatusWithLink("Sent!", pageUrl, "Open in Notion");
    cancelButton.disabled = false;
    cancelButton.textContent = "Close";
    sendSpinner.hidden = true;
    sendLabel.textContent = "Sent";
  } catch (err) {
    setStatus(err.message, "error");
    setSending(false);
    cancelButton.disabled = false;
  }
});

cancelButton.addEventListener("click", () => {
  window.close();
});

copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  const previousLabel = copyButton.textContent;
  try {
    const blob = await exportForClipboard();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    copyButton.textContent = "Copied!";
  } catch (err) {
    copyButton.textContent = "Copy failed";
    console.error("[bluenest-bugshot] clipboard copy failed:", err.message);
  } finally {
    setTimeout(() => {
      copyButton.textContent = previousLabel;
      copyButton.disabled = false;
    }, 1500);
  }
});

// --- Load the capture and draw the crop ----------------------------------

async function init() {
  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  if (!pendingCapture) {
    showError("No screenshot found. Close this tab and capture a region again.");
    return;
  }

  const { dataUrl, rect, pageMeta } = pendingCapture;
  captureRect = rect;
  capturePageMeta = pageMeta;

  const { lastSeverity } = await chrome.storage.local.get("lastSeverity");
  if (lastSeverity) severitySelect.value = lastSeverity;

  const image = new Image();
  image.onload = () => {
    const scale = rect.devicePixelRatio;
    originalImage = image;
    cropRect = {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };

    renderBase();
    setTool("select");
  };
  image.onerror = () => showError("Could not load the captured screenshot.");
  image.src = dataUrl;
}

init();
