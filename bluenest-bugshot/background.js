// Service worker. Can be killed at any time by Chrome — never hold flow
// state (screenshot, rectangle, metadata) in variables here. Pass capture
// data to editor.html via chrome.storage.session instead.

const RESTRICTED_URL_PATTERN = /^(chrome|chrome-extension|edge|about|chrome-error):/i;

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PATTERN.test(url) || url.startsWith("https://chrome.google.com/webstore");
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/128.png",
    title,
    message,
  }).catch((err) => {
    console.error("[bluenest-bugshot] failed to show notification:", err.message);
  });
}

async function startCapture(tab) {
  if (!tab || !tab.id) return;

  if (isRestrictedUrl(tab.url)) {
    notify(
      "Can't capture this page",
      "Chrome blocks extensions from capturing internal or restricted pages. Open a regular website tab and try again."
    );
    return;
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    console.error("[bluenest-bugshot] could not start capture on this tab:", err.message);
    notify(
      "Can't capture this page",
      "This page doesn't allow the extension to run on it. Open a regular website tab and try again."
    );
  }
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

async function handleRegionSelected(message, tab) {
  if (!tab || !tab.id) return;

  if (!isValidRect(message.rect)) {
    console.error("[bluenest-bugshot] ignoring malformed capture message:", message);
    return;
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    console.error("[bluenest-bugshot] captureVisibleTab failed:", err.message);
    notify("Capture failed", "Could not take a screenshot of this tab. Please try again.");
    return;
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

chrome.action.onClicked.addListener((tab) => {
  console.log("[bluenest-bugshot] action clicked on tab", tab.id, tab.url);
  startCapture(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  console.log("[bluenest-bugshot] command received:", command);
  if (command !== "capture-region") return;
  startCapture(await getActiveTab());
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
