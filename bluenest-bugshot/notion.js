// The only module that talks to the Notion API. Keep property names and
// version pinning here so a rename in Notion, or an API version bump,
// only requires a change in this file.

export const NOTION_VERSION = "2026-03-11";

// Maps our internal field names to the Notion database property names.
// Update this (not call sites) if someone renames a property in Notion.
export const NOTION_PROPERTIES = {
  title: "Title",
  status: "Status",
  severity: "Severity",
  pageUrl: "Page URL",
  pageTitle: "Page Title",
  browser: "Browser",
  os: "OS",
  viewport: "Viewport",
  pixelRatio: "Pixel Ratio",
  capturedAt: "Captured At",
  reporter: "Reporter",
  notes: "Notes",
};

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionGet(token, url, notFoundMessage) {
  let response;
  try {
    response = await fetch(url, { method: "GET", headers: notionHeaders(token) });
  } catch (err) {
    throw new Error("Network error reaching Notion. Check your internet connection.");
  }

  if (response.status === 401) {
    throw new Error("Invalid Notion token. Check the integration token in settings.");
  }
  if (response.status === 404) {
    throw new Error(notFoundMessage);
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") || "a few";
    throw new Error(`Rate limited by Notion. Retry in ${retryAfter} seconds.`);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Notion API error (${response.status}).`);
  }

  return response.json();
}

// Retrieves the database and resolves its first data source id. Notion
// databases can hold multiple data sources since the 2025-09-03 API
// change; page creation and schema lookups need a data_source_id, not
// the database_id.
async function fetchDatabase(token, databaseId) {
  return notionGet(
    token,
    `https://api.notion.com/v1/databases/${databaseId}`,
    "Database not found. Check the database ID, and make sure the database is shared with your integration."
  );
}

async function fetchDataSource(token, dataSourceId) {
  return notionGet(
    token,
    `https://api.notion.com/v1/data_sources/${dataSourceId}`,
    "Data source not found for this database."
  );
}

// Verifies the token/database pair works and the expected properties exist.
// Used by the "Test connection" button in options.js.
export async function testConnection({ token, databaseId }) {
  const database = await fetchDatabase(token, databaseId);

  const dataSources = database.data_sources || [];
  if (dataSources.length === 0) {
    throw new Error("This database has no data sources. Check the database in Notion.");
  }

  const title = (database.title || []).map((t) => t.plain_text).join("") || "(untitled)";
  const dataSourceId = dataSources[0].id;

  const dataSource = await fetchDataSource(token, dataSourceId);
  const schemaProperties = Object.keys(dataSource.properties || {});
  const missing = Object.values(NOTION_PROPERTIES).filter(
    (name) => !schemaProperties.includes(name)
  );

  return {
    title,
    dataSourceId,
    missingProperties: missing,
  };
}
