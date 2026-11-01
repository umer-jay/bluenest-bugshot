// Cloudflare Worker: the only place that holds the Notion OAuth client
// secret, and the only place that persists per-install token pairs. Never
// proxies actual Notion API calls (the extension still calls api.notion.com
// directly with whatever access_token this hands it) — this stays narrowly
// scoped to "manage the OAuth token lifecycle," nothing else.
//
// Routes:
//   POST /exchange  { code, installId, redirectUri } -> { workspaceName, workspaceIcon }
//   GET  /token?installId=...                         -> { accessToken, workspaceName }
//   POST /refresh   { installId }                      -> { accessToken }
//
// `installId` is a random UUID the extension generates once per install and
// sends with every request — the only thing tying a browser install to its
// KV record. This Worker never learns who the human is.

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function basicAuthHeader(env) {
  return `Basic ${btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)}`;
}

async function notionTokenRequest(env, body) {
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuthHeader(env),
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || `Notion returned ${response.status}`);
  }
  return data;
}

async function handleExchange(request, env) {
  const { code, installId, redirectUri } = await request.json().catch(() => ({}));
  if (!code || !installId || !redirectUri) {
    return json({ error: "Missing code, installId, or redirectUri" }, 400);
  }

  let tokenData;
  try {
    tokenData = await notionTokenRequest(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
  } catch (err) {
    return json({ error: `Could not connect to Notion: ${err.message}` }, 502);
  }

  await env.TOKENS.put(installId, JSON.stringify(tokenData));

  return json({
    workspaceName: tokenData.workspace_name || null,
    workspaceIcon: tokenData.workspace_icon || null,
  });
}

async function handleGetToken(request, env) {
  const installId = new URL(request.url).searchParams.get("installId");
  if (!installId) return json({ error: "Missing installId" }, 400);

  const stored = await env.TOKENS.get(installId);
  if (!stored) return json({ error: "Not connected" }, 404);

  const tokenData = JSON.parse(stored);
  return json({ accessToken: tokenData.access_token, workspaceName: tokenData.workspace_name || null });
}

async function handleRefresh(request, env) {
  const { installId } = await request.json().catch(() => ({}));
  if (!installId) return json({ error: "Missing installId" }, 400);

  const stored = await env.TOKENS.get(installId);
  if (!stored) return json({ error: "Not connected" }, 404);

  const tokenData = JSON.parse(stored);

  let newTokenData;
  try {
    // Notion rotates the refresh_token on every use — the one just used is
    // retired, so the new one from this response must be persisted, or the
    // next refresh will fail with an already-invalidated refresh_token.
    newTokenData = await notionTokenRequest(env, {
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token,
    });
  } catch (err) {
    return json({ error: `Could not refresh with Notion: ${err.message}` }, 502);
  }

  await env.TOKENS.put(installId, JSON.stringify(newTokenData));

  return json({ accessToken: newTokenData.access_token });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/exchange") {
      return handleExchange(request, env);
    }
    if (request.method === "GET" && url.pathname === "/token") {
      return handleGetToken(request, env);
    }
    if (request.method === "POST" && url.pathname === "/refresh") {
      return handleRefresh(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};
