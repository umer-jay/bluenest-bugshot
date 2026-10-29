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

function baseHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries once or twice on a 429 (waiting the length of Retry-After) before
// giving up, per plan.md's "rate limit (retry after a short delay)" case.
async function requestWithRetry(url, options) {
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
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

async function notionGet(token, url, notFoundMessage) {
  const response = await requestWithRetry(url, { method: "GET", headers: baseHeaders(token) });
  if (!response.ok) throw new Error(await readErrorMessage(response, notFoundMessage));
  return response.json();
}

async function notionPostJson(token, url, payload, notFoundMessage) {
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: { ...baseHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, notFoundMessage));
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
  if (!response.ok) throw new Error(await readErrorMessage(response));
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
    status: "New",
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
