// Classic (non-module) content script: Chrome re-executes this file's full
// source every time it's injected, so everything is wrapped in an IIFE to
// avoid "already declared" errors on repeat triggers, and a flag on
// `window` prevents a second overlay from stacking on top of an active one.
(function () {
  if (window.__qaCaptureActive) return;
  window.__qaCaptureActive = true;

  const MIN_SELECTION_PX = 10;

  const overlay = document.createElement("div");
  overlay.id = "qa-capture-overlay";

  const box = document.createElement("div");
  box.className = "qa-capture-box";

  const label = document.createElement("span");
  label.className = "qa-capture-label";
  box.appendChild(label);
  overlay.appendChild(box);

  const hint = document.createElement("div");
  hint.className = "qa-capture-hint";
  hint.textContent = "Drag to select a region. Esc to cancel.";
  overlay.appendChild(hint);

  document.documentElement.appendChild(overlay);

  let dragging = false;
  let startX = 0;
  let startY = 0;

  function rectFromPoints(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  function showBox(rect) {
    box.style.display = "block";
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    label.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function resetSelection() {
    dragging = false;
    box.style.display = "none";
  }

  function cleanup() {
    window.__qaCaptureActive = false;
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    overlay.setPointerCapture(e.pointerId);
    hint.style.display = "none";
    showBox(rectFromPoints(startX, startY, startX, startY));
  }

  function onPointerMove(e) {
    if (!dragging) return;
    showBox(rectFromPoints(startX, startY, e.clientX, e.clientY));
  }

  function onPointerUp(e) {
    if (!dragging) return;
    const rect = rectFromPoints(startX, startY, e.clientX, e.clientY);

    if (rect.width < MIN_SELECTION_PX || rect.height < MIN_SELECTION_PX) {
      resetSelection();
      hint.style.display = "block";
      return;
    }

    chrome.runtime.sendMessage({
      type: "qa-capture-region-selected",
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      },
    });

    cleanup();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
    }
  }

  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  document.addEventListener("keydown", onKeyDown, true);
})();
