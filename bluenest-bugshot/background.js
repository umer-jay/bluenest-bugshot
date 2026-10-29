// Service worker. Can be killed at any time by Chrome — never hold flow
// state (screenshot, rectangle, metadata) in variables here. Capture and
// editor handoff are added in a later step; for now the selected rectangle
// is just logged.

async function startCapture(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    console.error("[bluenest-bugshot] could not start capture on this tab:", err.message);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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
  if (message?.type === "qa-capture-region-selected") {
    console.log("[bluenest-bugshot] region selected on tab", sender.tab?.id, message.rect);
  }
});
