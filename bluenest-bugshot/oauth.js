// Client side of Notion OAuth: launches the consent flow via chrome.identity
// and talks to the Cloudflare Worker that holds the client secret and the
// per-install token pairs (see plan.md section 14 and worker/README.md).
// notion.js itself stays unaware this exists — it only ever sees a plain
// access token string, whether that came from here or from a manually
// pasted internal integration token.

const WORKER_BASE_URL = "https://bluenest-bugshot-oauth.umer-626.workers.dev";

// Client ID from the Notion public integration (plan.md section 14). Not
// secret — safe to hardcode in the extension; only the Client Secret must
// never appear here (it lives only as a Wrangler secret on the Worker).
const NOTION_CLIENT_ID = "40ad872b-594c-81ab-aed0-0037e0a7c6d8";

async function getOrCreateInstallId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ installId: newId });
  return newId;
}

// Fixed per extension ID (https://<extension-id>.chromiumapp.org/) — this is
// exactly why manifest.json's "key" field pins the extension's ID, so this
// URL is identical for every teammate regardless of where they unzip the
// extension, and can be registered once as Notion's redirect URI.
function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

export async function getConnectionStatus() {
  const { notionWorkspaceName } = await chrome.storage.local.get("notionWorkspaceName");
  return { workspaceName: notionWorkspaceName || null };
}

// Opens Notion's consent screen and exchanges the resulting code for tokens
// via the Worker. Throws with a readable message on cancellation or failure.
export async function connectToNotion() {
  const installId = await getOrCreateInstallId();
  const redirectUri = getRedirectUri();

  const authorizeUrl = new URL("https://api.notion.com/v1/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", NOTION_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("owner", "user");
  authorizeUrl.searchParams.set("state", installId);

  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    throw new Error("Notion authorization was cancelled or didn't complete.");
  }

  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) {
    throw new Error("Notion did not return an authorization code.");
  }

  const response = await fetch(`${WORKER_BASE_URL}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, installId, redirectUri }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not complete Notion authorization.");
  }

  await chrome.storage.local.set({ notionWorkspaceName: data.workspaceName || null });
  return { workspaceName: data.workspaceName || null };
}

// Returns the currently stored OAuth access token for this install, or null
// if never connected via OAuth. Deliberately doesn't try to refresh here —
// Notion doesn't document access token lifetime, so guessing an expiry
// window isn't possible; callers retry via refreshAccessToken() only after
// an actual 401 from a real Notion API call (see withNotionToken below).
async function getOAuthAccessToken() {
  const installId = await getOrCreateInstallId();
  const response = await fetch(`${WORKER_BASE_URL}/token?installId=${encodeURIComponent(installId)}`);
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not reach the Notion connection service.");
  }
  return data.accessToken;
}

async function refreshOAuthAccessToken() {
  const installId = await getOrCreateInstallId();
  const response = await fetch(`${WORKER_BASE_URL}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not refresh the Notion connection.");
  }
  return data.accessToken;
}

// Calls `fn(token)` with whatever token is available — an OAuth token if
// connected, otherwise the manually-pasted internal integration token from
// Settings — and retries once with a freshly refreshed token if the first
// attempt fails with a 401 and an OAuth token was in use. Refresh-retry only
// makes sense for OAuth tokens; a manually pasted token that's invalid stays
// invalid, there's nothing to refresh.
export async function withNotionToken(fn) {
  let token = await getOAuthAccessToken();
  const usingOAuth = Boolean(token);

  if (!token) {
    const { notionToken } = await chrome.storage.local.get("notionToken");
    token = notionToken || null;
  }

  if (!token) {
    throw new Error(
      "Set up Notion access in Settings first (Connect to Notion, or paste a token manually)."
    );
  }

  try {
    return await fn(token);
  } catch (err) {
    if (!usingOAuth || err.notionStatus !== 401) throw err;
    const refreshed = await refreshOAuthAccessToken();
    return fn(refreshed);
  }
}
