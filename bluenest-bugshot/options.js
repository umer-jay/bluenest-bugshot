import { testConnection } from "./notion.js";

const form = document.getElementById("settings-form");
const tokenInput = document.getElementById("token");
const databaseIdInput = document.getElementById("databaseId");
const reporterInput = document.getElementById("reporter");
const testButton = document.getElementById("test-button");
const saveButton = document.getElementById("save-button");
const statusEl = document.getElementById("status");

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error");
  if (kind) statusEl.classList.add(kind);
}

async function loadSettings() {
  const { notionToken, notionDatabaseId, reporterName } = await chrome.storage.local.get([
    "notionToken",
    "notionDatabaseId",
    "reporterName",
  ]);
  if (notionToken) tokenInput.value = notionToken;
  if (notionDatabaseId) databaseIdInput.value = notionDatabaseId;
  if (reporterName) reporterInput.value = reporterName;
}

async function saveSettings(event) {
  event.preventDefault();
  await chrome.storage.local.set({
    notionToken: tokenInput.value.trim(),
    notionDatabaseId: databaseIdInput.value.trim(),
    reporterName: reporterInput.value.trim(),
  });
  setStatus("Settings saved.", "success");
}

async function handleTestConnection() {
  const token = tokenInput.value.trim();
  const databaseId = databaseIdInput.value.trim();

  if (!token || !databaseId) {
    setStatus("Enter a token and a database ID before testing.", "error");
    return;
  }

  testButton.disabled = true;
  saveButton.disabled = true;
  setStatus("Testing connection…");

  try {
    const result = await testConnection({ token, databaseId });
    if (result.missingProperties.length > 0) {
      setStatus(
        `Connected to "${result.title}", but it's missing these properties: ${result.missingProperties.join(", ")}.`,
        "error"
      );
    } else {
      setStatus(`Connected to "${result.title}". All expected properties found.`, "success");
    }
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    testButton.disabled = false;
    saveButton.disabled = false;
  }
}

form.addEventListener("submit", saveSettings);
testButton.addEventListener("click", handleTestConnection);
document.addEventListener("DOMContentLoaded", loadSettings);
loadSettings();
