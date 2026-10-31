// Service worker. Can be killed at any time by Chrome — never hold flow
// state (screenshot, rectangle, metadata) in variables here. Pass capture
// data to editor.html via chrome.storage.session instead.

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|chrome-error):/i;
const FULL_PAGE_CAPTURE_DELAY_MS = 600; // stay under captureVisibleTab's 2-calls/sec quota
const FULL_PAGE_MAX_SHOTS = 25; // safety cap for pathological/infinite-scroll pages
const FULL_PAGE_MAX_HEIGHT_PX = 30000; // stay safely under Chrome's canvas size limit

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PATTERN.test(url) || url.startsWith("https://chrome.google.com/webstore");
}

function notify(title, message) {
  chrome.notifications
    .create({ type: "basic", iconUrl: "icons/128.png", title, message })
    .catch((err) => {
      console.error("[bluenest-bugshot] failed to show notification:", err.message);
    });
}

function notifyCannotCapture() {
  notify(
    "Can't capture this page",
    "Chrome blocks extensions from capturing internal or restricted pages. Open a regular website tab and try again."
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isValidRect(rect) {
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0 &&
    Number.isFinite(rect.devicePixelRatio) &&
    rect.devicePixelRatio > 0
  );
}

// Shared by all three capture modes (region-select, visible-area, full-page).
// `precomputedDataUrl` lets full-page capture supply its own stitched image
// instead of this function grabbing a fresh (single-viewport) screenshot.
async function handleRegionSelected(message, tab, precomputedDataUrl) {
  if (!tab || !tab.id) return;

  if (!isValidRect(message.rect)) {
    console.error("[bluenest-bugshot] ignoring malformed capture message:", message);
    return;
  }

  let dataUrl = precomputedDataUrl;
  if (!dataUrl) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (err) {
      console.error("[bluenest-bugshot] captureVisibleTab failed:", err.message);
      notify("Capture failed", "Could not take a screenshot of this tab. Please try again.");
      return;
    }
  }

  const capture = {
    dataUrl,
    rect: message.rect,
    pageMeta: {
      url: tab.url,
      title: tab.title,
      userAgent: navigator.userAgent,
      viewportWidth: message.viewport?.width,
      viewportHeight: message.viewport?.height,
      capturedAt: new Date().toISOString(),
    },
  };

  try {
    await chrome.storage.session.set({ pendingCapture: capture });
  } catch (err) {
    console.error("[bluenest-bugshot] could not store capture:", err.message);
    notify("Capture too large", "This screenshot was too large to process. Try a smaller selection.");
    return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
}

// --- Mode 1: region select (existing drag-overlay flow) -------------------

async function startCapture(tab) {
  if (!tab || !tab.id) return;

  if (isRestrictedUrl(tab.url)) {
    notifyCannotCapture();
    return;
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    console.error("[bluenest-bugshot] could not start capture on this tab:", err.message);
    notifyCannotCapture();
  }
}

// --- Mode 2: capture the visible area, no selection needed -----------------

async function captureVisibleOnly(tab) {
  if (!tab || !tab.id) return;

  if (isRestrictedUrl(tab.url)) {
    notifyCannotCapture();
    return;
  }

  let viewport;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    });
    viewport = result;
  } catch (err) {
    console.error("[bluenest-bugshot] could not measure viewport:", err.message);
    notifyCannotCapture();
    return;
  }

  const rect = {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
    devicePixelRatio: viewport.devicePixelRatio,
  };
  await handleRegionSelected({ rect, viewport }, tab);
}

// --- Mode 3: full-page (scrolling) capture ---------------------------------
// Known limitation: fixed/sticky elements (headers, cookie banners) will
// appear once per captured screen, so they're duplicated down the stitched
// image at each seam. Detecting and hiding them during capture would fix
// this but adds real complexity; every basic scroll-and-stitch tool has the
// same limitation.

async function measurePage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollY: window.scrollY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      totalHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      devicePixelRatio: window.devicePixelRatio,
    }),
  });
  return result;
}

async function scrollTabTo(tabId, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (scrollY) => window.scrollTo(0, scrollY),
    args: [y],
  });
}

async function captureVisibleTabWithRetry(windowId, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, options);
    } catch (err) {
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message) && attempt < 3) {
        await sleep(FULL_PAGE_CAPTURE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

// Service workers have no DOM, so stitching happens with OffscreenCanvas
// (natively supported here) instead of the <canvas>/Image() pattern used in
// editor.js. Converts the result to a data URL in chunks to avoid a stack
// overflow from String.fromCharCode on a large byte array.
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function stitchShots(shots, totalWidthPx, totalHeightPx) {
  const canvas = new OffscreenCanvas(totalWidthPx, totalHeightPx);
  const ctx = canvas.getContext("2d");
  for (const shot of shots) {
    const blob = await (await fetch(shot.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, shot.yPx);
    bitmap.close();
  }
  // JPEG, not PNG: a tall stitched page can be large, and chrome.storage.session
  // has a 10MB quota for the handoff to editor.html.
  const resultBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  return blobToDataUrl(resultBlob);
}

async function captureFullPage(tab) {
  if (!tab || !tab.id) return;

  if (isRestrictedUrl(tab.url)) {
    notifyCannotCapture();
    return;
  }

  let page;
  try {
    page = await measurePage(tab.id);
  } catch (err) {
    console.error("[bluenest-bugshot] could not measure page:", err.message);
    notifyCannotCapture();
    return;
  }

  const { viewportWidth, viewportHeight, totalHeight, devicePixelRatio, scrollY: originalScrollY } = page;

  // Nothing to scroll — same as "capture visible area", no stitching needed.
  if (totalHeight <= viewportHeight + 2) {
    const rect = { x: 0, y: 0, width: viewportWidth, height: viewportHeight, devicePixelRatio };
    await handleRegionSelected(
      { rect, viewport: { width: viewportWidth, height: viewportHeight } },
      tab
    );
    return;
  }

  const neededShots = Math.ceil(totalHeight / viewportHeight);
  const maxShotsForCanvas = Math.max(
    1,
    Math.floor(FULL_PAGE_MAX_HEIGHT_PX / (viewportHeight * devicePixelRatio))
  );
  const shotCount = Math.min(FULL_PAGE_MAX_SHOTS, maxShotsForCanvas, neededShots);
  const cappedHeight = shotCount < neededShots ? shotCount * viewportHeight : totalHeight;

  if (shotCount < neededShots) {
    notify(
      "Page is very long",
      `Capturing the first ${shotCount} screens only — the rest of the page was skipped.`
    );
  }

  const shots = [];
  try {
    for (let i = 0; i < shotCount; i++) {
      const y = i === shotCount - 1 ? cappedHeight - viewportHeight : i * viewportHeight;
      await scrollTabTo(tab.id, y);
      await sleep(FULL_PAGE_CAPTURE_DELAY_MS);
      const dataUrl = await captureVisibleTabWithRetry(tab.windowId, { format: "png" });
      shots.push({ dataUrl, yPx: Math.round(y * devicePixelRatio) });
    }
  } catch (err) {
    console.error("[bluenest-bugshot] full-page capture failed:", err.message);
    notify("Capture failed", "Could not capture the full page. Please try again.");
    await scrollTabTo(tab.id, originalScrollY).catch(() => {});
    return;
  }

  await scrollTabTo(tab.id, originalScrollY).catch(() => {});

  let stitchedDataUrl;
  try {
    const totalWidthPx = Math.round(viewportWidth * devicePixelRatio);
    const totalHeightPx = Math.round(cappedHeight * devicePixelRatio);
    stitchedDataUrl = await stitchShots(shots, totalWidthPx, totalHeightPx);
  } catch (err) {
    console.error("[bluenest-bugshot] stitching failed:", err.message);
    notify("Capture failed", "Could not combine the page into one image. Please try again.");
    return;
  }

  const rect = { x: 0, y: 0, width: viewportWidth, height: cappedHeight, devicePixelRatio };
  await handleRegionSelected(
    { rect, viewport: { width: viewportWidth, height: cappedHeight } },
    tab,
    stitchedDataUrl
  );
}

// --- Triggers: toolbar icon, keyboard shortcuts, right-click menu ----------

chrome.action.onClicked.addListener((tab) => {
  console.log("[bluenest-bugshot] action clicked on tab", tab.id, tab.url);
  startCapture(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  console.log("[bluenest-bugshot] command received:", command);
  const tab = await getActiveTab();
  if (command === "capture-region") startCapture(tab);
  else if (command === "capture-visible") captureVisibleOnly(tab);
  else if (command === "capture-fullpage") captureFullPage(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "capture-visible",
      title: "Capture visible area",
      contexts: ["action"],
    });
    chrome.contextMenus.create({
      id: "capture-fullpage",
      title: "Capture full page",
      contexts: ["action"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "capture-visible") captureVisibleOnly(tab);
  else if (info.menuItemId === "capture-fullpage") captureFullPage(tab);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  // Defense in depth: nothing external can actually reach this listener
  // (no externally_connectable declared), but verify the sender is this
  // extension's own content script rather than trusting message.type alone.
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type !== "qa-capture-region-selected") return;
  console.log("[bluenest-bugshot] region selected on tab", sender.tab?.id, message.rect);
  handleRegionSelected(message, sender.tab);
});
