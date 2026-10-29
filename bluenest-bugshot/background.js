// Service worker. Can be killed at any time by Chrome — never hold flow
// state (screenshot, rectangle, metadata) in variables here. Region
// selection, capture, and editor handoff are added in later steps.

chrome.action.onClicked.addListener((tab) => {
  console.log("[bluenest-bugshot] action clicked on tab", tab.id, tab.url);
});

chrome.commands.onCommand.addListener((command) => {
  console.log("[bluenest-bugshot] command received:", command);
});
