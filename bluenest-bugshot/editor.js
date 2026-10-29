// Sending to Notion is wired up in a later step. For now, Send flattens
// and exports the image so the annotation flow can be verified end to end.

const MAX_EXPORT_WIDTH = 1600;
const EXPORT_QUALITY = 0.85;

const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");
const toolbarEl = document.getElementById("toolbar");
const canvasStack = document.getElementById("canvas-stack");
const baseCanvas = document.getElementById("base-canvas");
const annotationCanvas = document.getElementById("annotation-canvas");
const actx = annotationCanvas.getContext("2d");
const detailsForm = document.getElementById("details-form");
const titleInput = document.getElementById("title-input");
const sendButton = document.getElementById("send-button");
const cancelButton = document.getElementById("cancel-button");
const statusEl = document.getElementById("status");
const undoButton = document.getElementById("undo-button");
const clearButton = document.getElementById("clear-button");
const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
const colorButtons = Array.from(document.querySelectorAll(".color-swatch"));

let captureRect = null;
let annotations = [];
let draft = null;
let dragStart = null;
let currentTool = "select";
let currentColor = "#dc2626";

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

function drawAnnotation(ctx2d, ann) {
  if (ann.type === "rect") drawRect(ctx2d, ann);
  else if (ann.type === "arrow") drawArrow(ctx2d, ann);
  else if (ann.type === "text") drawText(ctx2d, ann);
}

function redraw() {
  actx.clearRect(0, 0, annotationCanvas.width, annotationCanvas.height);
  for (const ann of annotations) drawAnnotation(actx, ann);
  if (draft) drawAnnotation(actx, draft);
}

// --- Tools and color ------------------------------------------------------

function setTool(tool) {
  currentTool = tool;
  for (const btn of toolButtons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.tool === tool));
  }
  annotationCanvas.style.cursor =
    tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
}

function setColor(color) {
  currentColor = color;
  for (const btn of colorButtons) {
    btn.setAttribute("aria-pressed", String(btn.dataset.color === color));
  }
}

toolButtons.forEach((btn) => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
colorButtons.forEach((btn) => btn.addEventListener("click", () => setColor(btn.dataset.color)));

// --- Rectangle / arrow drag -------------------------------------------

function buildShapeDraft(start, end) {
  if (currentTool === "rect") {
    return {
      type: "rect",
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
      color: currentColor,
    };
  }
  if (currentTool === "arrow") {
    return { type: "arrow", x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: currentColor };
  }
  return null;
}

function shapeIsEmpty(shape) {
  if (!shape) return true;
  if (shape.type === "rect") return shape.width < 2 || shape.height < 2;
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

  dragStart = point;
  annotationCanvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!dragStart) return;
  draft = buildShapeDraft(dragStart, getCanvasPoint(e));
  redraw();
}

function onPointerUp(e) {
  if (!dragStart) return;
  const shape = buildShapeDraft(dragStart, getCanvasPoint(e));
  dragStart = null;
  draft = null;

  if (!shapeIsEmpty(shape)) annotations.push(shape);
  redraw();
}

annotationCanvas.addEventListener("pointerdown", onPointerDown);
annotationCanvas.addEventListener("pointermove", onPointerMove);
annotationCanvas.addEventListener("pointerup", onPointerUp);

// --- Text tool --------------------------------------------------------

function openTextInput(canvasPoint) {
  const { left, top } = canvasPointToCss(canvasPoint);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "annotation-text-input";
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  input.style.color = currentColor;
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
    const fontSize = Math.round(24 * (captureRect.devicePixelRatio || 1));
    annotations.push({
      type: "text",
      x: canvasPoint.x,
      y: canvasPoint.y,
      text: value,
      color: currentColor,
      fontSize,
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

function undo() {
  if (annotations.length === 0) return;
  annotations.pop();
  redraw();
}

function clearAll() {
  annotations = [];
  redraw();
}

undoButton.addEventListener("click", undo);
clearButton.addEventListener("click", clearAll);

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  }
});

// --- Export -------------------------------------------------------------

async function exportFlattenedImage() {
  const sourceWidth = baseCanvas.width;
  const sourceHeight = baseCanvas.height;
  const scale = Math.min(1, MAX_EXPORT_WIDTH / sourceWidth);
  const targetWidth = Math.round(sourceWidth * scale);
  const targetHeight = Math.round(sourceHeight * scale);

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = targetWidth;
  exportCanvas.height = targetHeight;
  const exportCtx = exportCanvas.getContext("2d");
  exportCtx.drawImage(baseCanvas, 0, 0, targetWidth, targetHeight);
  exportCtx.drawImage(annotationCanvas, 0, 0, targetWidth, targetHeight);

  const blob = await new Promise((resolve) =>
    exportCanvas.toBlob(resolve, "image/jpeg", EXPORT_QUALITY)
  );

  return { blob, width: targetWidth, height: targetHeight };
}

detailsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  sendButton.disabled = true;
  setStatus("Exporting…");

  try {
    const { blob, width, height } = await exportFlattenedImage();
    const sizeKb = Math.round(blob.size / 1024);
    const previewUrl = URL.createObjectURL(blob);
    window.open(previewUrl, "_blank");
    setStatus(
      `Export ready: ${width}×${height}px, ${sizeKb}KB — opened in a new tab. ` +
        `(Sending to Notion isn't wired up yet.)`,
      "success"
    );
  } catch (err) {
    setStatus(`Export failed: ${err.message}`, "error");
  } finally {
    sendButton.disabled = false;
  }
});

cancelButton.addEventListener("click", () => {
  window.close();
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

  const image = new Image();
  image.onload = () => {
    const scale = rect.devicePixelRatio;
    const sx = Math.round(rect.x * scale);
    const sy = Math.round(rect.y * scale);
    const sWidth = Math.round(rect.width * scale);
    const sHeight = Math.round(rect.height * scale);

    baseCanvas.width = sWidth;
    baseCanvas.height = sHeight;
    baseCanvas.getContext("2d").drawImage(image, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

    annotationCanvas.width = sWidth;
    annotationCanvas.height = sHeight;

    metaEl.textContent = `${pageMeta.title} — ${pageMeta.url} — ${sWidth}×${sHeight}px (pixel ratio ${scale})`;
    setTool("select");
  };
  image.onerror = () => showError("Could not load the captured screenshot.");
  image.src = dataUrl;
}

init();
