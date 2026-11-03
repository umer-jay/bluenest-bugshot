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

// Columns that databases created from Settings get, but that sending doesn't
// require or fill in. They're kept out of NOTION_PROPERTIES on purpose: that
// list is checked before every send (missingPropertyNames), so adding them
// there would break every existing database that lacks these columns.
export const OPTIONAL_NOTION_PROPERTIES = {
  assignee: "Assignee",
};

// Status value every new card is created with. Also the first option of the
// Status column in databases created via createQaDatabase(), so the two can't
// drift apart.
const DEFAULT_STATUS = "New";

// Property types for a database created from Settings ("Create one").
// Built from NOTION_PROPERTIES so a rename there carries over automatically.
// Status is a Select, not a Status-type column: a new Status column can only
// start with Notion's own default groups/options, which don't include "New".
// buildPropertyValue handles either type, so existing databases with a real
// Status column keep working.
function buildQaDatabaseSchema() {
  const P = NOTION_PROPERTIES;
  return {
    [P.title]: { title: {} },
    [P.status]: {
      select: {
        options: [
          { name: DEFAULT_STATUS, color: "blue" },
          { name: "In Progress", color: "yellow" },
          { name: "Done", color: "green" },
          { name: "Won't Fix", color: "gray" },
        ],
      },
    },
    [P.severity]: {
      select: {
        options: [
          { name: "Low", color: "gray" },
          { name: "Medium", color: "yellow" },
          { name: "High", color: "orange" },
          { name: "Critical", color: "red" },
        ],
      },
    },
    [P.pageUrl]: { url: {} },
    [P.pageTitle]: { rich_text: {} },
    [P.browser]: { rich_text: {} },
    [P.os]: { rich_text: {} },
    [P.viewport]: { rich_text: {} },
    [P.pixelRatio]: { number: { format: "number" } },
    [P.capturedAt]: { date: {} },
    [P.reporter]: { rich_text: {} },
    [P.notes]: { rich_text: {} },
    // People-type, so it holds real workspace members and Notion can notify
    // them. Assigned in Notion for now; the editor doesn't set it.
    [OPTIONAL_NOTION_PROPERTIES.assignee]: { people: {} },
  };
}

function baseHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const REQUEST_TIMEOUT_MS = 20000;

// A hung connection to api.notion.com would otherwise leave the caller
// (editor.js's Send flow) stuck on "Uploading…" forever, with neither the
// success nor the catch path ever firing.
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Retries once or twice on a 429 (waiting the length of Retry-After) before
// giving up, per plan.md's "rate limit (retry after a short delay)" case.
async function requestWithRetry(url, options) {
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetchWithTimeout(url, options);
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error("Request to Notion timed out. Check your connection and try again.");
      }
      throw new Error("Network error reaching Notion. Check your internet connection.");
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfterSeconds = Number(response.headers.get("Retry-After")) || 1;
      await sleep(retryAfterSeconds * 1000);
      attempt += 1;
      continue;
    }

    return response;
  }
}

async function readErrorMessage(response, notFoundMessage) {
  if (response.status === 401) {
    return "Invalid Notion token. Check the integration token in settings.";
  }
  if (response.status === 404) {
    return notFoundMessage || "Not found in Notion.";
  }
  if (response.status === 429) {
    return "Notion is rate-limiting requests. Please wait a moment and try again.";
  }
  const body = await response.json().catch(() => ({}));
  return body.message || `Notion API error (${response.status}).`;
}

// Tags the thrown Error with the HTTP status so callers can tell "token
// expired" (401) apart from any other failure without string-matching the
// message — specifically so oauth.js can retry once after a refresh on a
// 401 without needing to retry on, say, a 404 or a validation error.
async function throwNotionError(response, notFoundMessage) {
  const err = new Error(await readErrorMessage(response, notFoundMessage));
  err.notionStatus = response.status;
  throw err;
}

async function notionGet(token, url, notFoundMessage) {
  const response = await requestWithRetry(url, { method: "GET", headers: baseHeaders(token) });
  if (!response.ok) await throwNotionError(response, notFoundMessage);
  return response.json();
}

async function notionPostJson(token, url, payload, notFoundMessage) {
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) await throwNotionError(response, notFoundMessage);
  return response.json();
}

async function notionPostForm(token, url, formData) {
  // Don't set Content-Type manually — fetch needs to generate the
  // multipart boundary itself from the FormData body.
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: baseHeaders(token),
    body: formData,
  });
  if (!response.ok) await throwNotionError(response);
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

// Shared by testConnection and sendCapture so both work from the same
// database_id -> data_source_id -> schema resolution.
async function resolveDatabase(token, databaseId) {
  const database = await fetchDatabase(token, databaseId);

  const dataSources = database.data_sources || [];
  if (dataSources.length === 0) {
    throw new Error("This database has no data sources. Check the database in Notion.");
  }

  const dataSourceId = dataSources[0].id;
  const dataSource = await fetchDataSource(token, dataSourceId);
  const title = (database.title || []).map((t) => t.plain_text).join("") || "(untitled)";

  return { title, dataSourceId, properties: dataSource.properties || {} };
}

function missingPropertyNames(schemaProperties) {
  const names = Object.keys(schemaProperties);
  return Object.values(NOTION_PROPERTIES).filter((name) => !names.includes(name));
}

// Verifies the token/database pair works and the expected properties exist.
// Used by the "Test connection" button in options.js.
export async function testConnection({ token, databaseId }) {
  const { title, dataSourceId, properties } = await resolveDatabase(token, databaseId);
  return { title, dataSourceId, missingProperties: missingPropertyNames(properties) };
}

// Lists every database this token's connection can see, for the Settings
// page's "pick a database" dropdown (an alternative to copying a database ID
// by hand). Notion's search filter only supports "page" or "data_source" as
// object types under the current API version — there's no "database" filter
// value — so this searches data sources and reads each result's
// parent.database_id, which is the same kind of ID testConnection/sendCapture
// already expect from the manual "Database ID" field.
export async function searchAccessibleDatabases(token) {
  const response = await notionPostJson(token, "https://api.notion.com/v1/search", {
    filter: { property: "object", value: "data_source" },
    page_size: 100,
  });

  return (response.results || [])
    .filter((result) => result.parent?.type === "database_id")
    .map((result) => ({
      databaseId: result.parent.database_id,
      title: (result.title || []).map((t) => t.plain_text).join("") || "(untitled)",
    }));
}

function extractPageTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find((p) => p.type === "title");
  return (titleProperty?.title || []).map((t) => t.plain_text).join("") || "(untitled)";
}

// Lists regular pages this connection can see, to use as the parent for
// createQaDatabase(). Rows of a database are pages too, so those are filtered
// out: creating the QA database inside a row of some other database would
// just be confusing.
export async function searchAccessiblePages(token) {
  const response = await notionPostJson(token, "https://api.notion.com/v1/search", {
    filter: { property: "object", value: "page" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
    page_size: 100,
  });

  return (response.results || [])
    .filter((page) => page.parent?.type !== "database_id" && page.parent?.type !== "data_source_id")
    .map((page) => ({ pageId: page.id, title: extractPageTitle(page) }));
}

// Creates a database with the full schema Bugshot expects (see
// buildQaDatabaseSchema) inside `parentPageId`. It's created as an inline
// table inside a page, not as a top-level database. Top-level databases have
// come back from the API with an empty data_sources array (see the
// "no data sources" note in README troubleshooting), and the inline form is
// the known-good one. Returns the new database's ID, the same kind of ID the
// dropdown and the manual "Database ID" field store.
export async function createQaDatabase({ token, parentPageId, title }) {
  const database = await notionPostJson(
    token,
    "https://api.notion.com/v1/databases",
    {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: title } }],
      is_inline: true,
      initial_data_source: { properties: buildQaDatabaseSchema() },
    },
    "Parent page not found. Make sure it's shared with this connection."
  );
  return { databaseId: database.id, title, url: database.url };
}

// --- Sending a capture ------------------------------------------------

function buildPropertyValue(type, rawValue) {
  switch (type) {
    case "title":
      return { title: rawValue ? [{ type: "text", text: { content: String(rawValue) } }] : [] };
    case "rich_text":
      return { rich_text: rawValue ? [{ type: "text", text: { content: String(rawValue) } }] : [] };
    case "url":
      return { url: rawValue || null };
    case "number":
      return { number: rawValue === null || rawValue === undefined ? null : Number(rawValue) };
    case "date":
      return { date: rawValue ? { start: rawValue } : null };
    case "select":
      return { select: rawValue ? { name: String(rawValue) } : null };
    case "status":
      return { status: rawValue ? { name: String(rawValue) } : null };
    default:
      return null;
  }
}

function parseBrowser(userAgent) {
  const match = userAgent.match(/(Chrome|Firefox|Safari|Edg)\/([\d.]+)/);
  if (!match) return userAgent || "Unknown";
  const name = match[1] === "Edg" ? "Edge" : match[1];
  return `${name} ${match[2]}`;
}

function parseOS(userAgent) {
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  if (/Android/.test(userAgent)) return "Android";
  return "Unknown";
}

async function createFileUpload(token, filename, contentType) {
  return notionPostJson(token, "https://api.notion.com/v1/file_uploads", {
    mode: "single_part",
    filename,
    content_type: contentType,
  });
}

async function sendFileUploadContent(token, fileUploadId, blob, filename) {
  const formData = new FormData();
  formData.append("file", blob, filename);
  return notionPostForm(
    token,
    `https://api.notion.com/v1/file_uploads/${fileUploadId}/send`,
    formData
  );
}

// Uploads the screenshot and creates the QA Pipeline page. Throws with a
// readable message on any failure; the caller (editor.js) is responsible
// for not losing the user's annotations when that happens.
export async function sendCapture({
  token,
  databaseId,
  blob,
  title,
  severity,
  notes,
  reporter,
  pageMeta,
  devicePixelRatio,
}) {
  const { dataSourceId, properties: schema } = await resolveDatabase(token, databaseId);

  const missing = missingPropertyNames(schema);
  if (missing.length > 0) {
    throw new Error(
      `Database is missing these properties: ${missing.join(", ")}. Fix this in Notion, then try again.`
    );
  }

  const upload = await createFileUpload(token, "screenshot.jpg", blob.type || "image/jpeg");
  const uploaded = await sendFileUploadContent(token, upload.id, blob, "screenshot.jpg");
  if (uploaded.status !== "uploaded") {
    throw new Error(`Notion file upload did not complete (status: ${uploaded.status}).`);
  }

  const fieldValues = {
    title,
    status: DEFAULT_STATUS,
    severity,
    pageUrl: pageMeta.url,
    pageTitle: pageMeta.title,
    browser: parseBrowser(pageMeta.userAgent || ""),
    os: parseOS(pageMeta.userAgent || ""),
    viewport:
      pageMeta.viewportWidth && pageMeta.viewportHeight
        ? `${pageMeta.viewportWidth}×${pageMeta.viewportHeight}`
        : "",
    pixelRatio: devicePixelRatio,
    capturedAt: pageMeta.capturedAt,
    reporter: reporter || "",
    notes: notes || "",
  };

  const properties = {};
  for (const [field, notionName] of Object.entries(NOTION_PROPERTIES)) {
    const value = buildPropertyValue(schema[notionName].type, fieldValues[field]);
    if (value) properties[notionName] = value;
  }

  const page = await notionPostJson(token, "https://api.notion.com/v1/pages", {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties,
    children: [
      {
        object: "block",
        type: "image",
        image: { type: "file_upload", file_upload: { id: upload.id } },
      },
    ],
  });

  return { pageUrl: page.url };
}
