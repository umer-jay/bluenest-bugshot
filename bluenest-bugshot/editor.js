// Annotation tools and the send-to-Notion form are added in later steps.
// For now this just proves the crop math is correct.

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const metaEl = document.getElementById("meta");
const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  canvas.hidden = true;
  metaEl.hidden = true;
}

async function init() {
  const { pendingCapture } = await chrome.storage.session.get("pendingCapture");
  if (!pendingCapture) {
    showError("No screenshot found. Close this tab and capture a region again.");
    return;
  }

  const { dataUrl, rect, pageMeta } = pendingCapture;

  const image = new Image();
  image.onload = () => {
    const scale = rect.devicePixelRatio;
    const sx = Math.round(rect.x * scale);
    const sy = Math.round(rect.y * scale);
    const sWidth = Math.round(rect.width * scale);
    const sHeight = Math.round(rect.height * scale);

    canvas.width = sWidth;
    canvas.height = sHeight;
    ctx.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

    metaEl.textContent = `${pageMeta.title} — ${pageMeta.url} — ${sWidth}×${sHeight}px (pixel ratio ${scale})`;
  };
  image.onerror = () => showError("Could not load the captured screenshot.");
  image.src = dataUrl;
}

init();
