import { testConnection, searchAccessibleDatabases } from "./notion.js";
import { connectToNotion, getConnectionStatus, withNotionToken } from "./oauth.js";

const form = document.getElementById("settings-form");
const connectStatusEl = document.getElementById("connect-status");
const connectButton = document.getElementById("connect-button");
const tokenInput = document.getElementById("token");
const databaseIdInput = document.getElementById("databaseId");
const databaseSelect = document.getElementById("databaseSelect");
const refreshDatabasesButton = document.getElementById("refresh-databases-button");
const reporterInput = document.getElementById("reporter");
const testButton = document.getElementById("test-button");
const saveButton = document.getElementById("save-button");
const statusEl = document.getElementById("status");

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.classList.remove("success", "error");
  if (kind) statusEl.classList.add(kind);
}

function renderConnectStatus(workspaceName) {
  if (workspaceName) {
    connectStatusEl.textContent = `Connected to "${workspaceName}".`;
    connectStatusEl.classList.add("connected");
    connectButton.textContent = "Reconnect";
  } else {
    connectStatusEl.textContent = "Not connected to Notion.";
    connectStatusEl.classList.remove("connected");
    connectButton.textContent = "Connect to Notion";
  }
}

async function refreshConnectStatus() {
  const { workspaceName } = await getConnectionStatus();
  renderConnectStatus(workspaceName);
  return workspaceName;
}

// The dropdown wins over the manually pasted database ID field when both
// have a value — same precedence oauth.js's withNotionToken applies between
// an OAuth token and a manually pasted one.
function resolveDatabaseId() {
  return databaseSelect.value || databaseIdInput.value.trim();
}

async function populateDatabaseDropdown(selectedId) {
  databaseSelect.disabled = true;
  refreshDatabasesButton.disabled = true;
  databaseSelect.innerHTML = '<option value="">Loading databases…</option>';

  try {
    const databases = await withNotionToken((token) => searchAccessibleDatabases(token));
    databaseSelect.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent =
      databases.length === 0 ? "No databases shared with this connection yet" : "— Select a database —";
    databaseSelect.appendChild(placeholder);

    for (const db of databases) {
      const option = document.createElement("option");
      option.value = db.databaseId;
      option.textContent = db.title;
      databaseSelect.appendChild(option);
    }

    if (selectedId && databases.some((db) => db.databaseId === selectedId)) {
      databaseSelect.value = selectedId;
    }
  } catch (err) {
    databaseSelect.innerHTML = `<option value="">Could not load databases</option>`;
    console.error("[bluenest-bugshot] could not list databases:", err.message);
  } finally {
    databaseSelect.disabled = false;
    refreshDatabasesButton.disabled = false;
  }
}

async function handleConnectClick() {
  connectButton.disabled = true;
  setStatus("Opening Notion…");
  try {
    const { workspaceName } = await connectToNotion();
    renderConnectStatus(workspaceName);
    setStatus(`Connected to "${workspaceName}".`, "success");
    await populateDatabaseDropdown(resolveDatabaseId());
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    connectButton.disabled = false;
  }
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

  const workspaceName = await refreshConnectStatus();
  if (workspaceName) {
    await populateDatabaseDropdown(notionDatabaseId);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  await chrome.storage.local.set({
    notionToken: tokenInput.value.trim(),
    notionDatabaseId: resolveDatabaseId(),
    reporterName: reporterInput.value.trim(),
  });
  setStatus("Settings saved.", "success");
}

async function handleTestConnection() {
  const databaseId = resolveDatabaseId();

  if (!databaseId) {
    setStatus("Pick a database (or enter a database ID) before testing.", "error");
    return;
  }

  testButton.disabled = true;
  saveButton.disabled = true;
  setStatus("Testing connection…");

  try {
    const result = await withNotionToken((token) => testConnection({ token, databaseId }));
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

connectButton.addEventListener("click", handleConnectClick);
refreshDatabasesButton.addEventListener("click", () => populateDatabaseDropdown(resolveDatabaseId()));
form.addEventListener("submit", saveSettings);
testButton.addEventListener("click", handleTestConnection);
document.addEventListener("DOMContentLoaded", loadSettings);
loadSettings();
