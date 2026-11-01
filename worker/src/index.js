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

// Served at GET /privacy — needed as a public URL for the Chrome Web Store
// listing. Lives here, not as a separate hosted page, because GitHub Pages
// isn't available on a private repo without a paid plan — this Worker is
// already public and already deployed, so it's the simplest place for it.
// This is the single source of truth; don't also keep a docs/ copy.
const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bluenest Bugshot — Privacy Policy</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      body {
        max-width: 680px;
        margin: 0 auto;
        padding: 2.5rem 1.5rem 4rem;
        line-height: 1.6;
      }
      h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
      .updated { color: #6b7280; font-size: 0.9rem; margin-bottom: 2rem; }
      h2 { font-size: 1.1rem; margin-top: 2rem; }
      code { background: rgba(128, 128, 128, 0.15); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
    </style>
  </head>
  <body>
    <h1>Bluenest Bugshot — Privacy Policy</h1>
    <p class="updated">Last updated: November 2026</p>

    <p>
      Bluenest Bugshot is an internal tool for Bluenest's own QA team. It lets a tester select a region
      of a web page, annotate it, and send it as a card to a Notion database the tester controls. This
      page explains exactly what data the extension touches and where it goes.
    </p>

    <h2>What the extension does with your data</h2>
    <p>
      The extension only captures a screenshot when you explicitly trigger it (clicking its toolbar
      icon, a keyboard shortcut, or its right-click menu). It never captures or transmits anything in
      the background or without that direct action.
    </p>
    <p>
      Once captured, the screenshot and any annotations you add are processed entirely inside your
      browser (using the Canvas API) until you choose to send it. When you click <strong>Send</strong>,
      the following is sent directly from your browser to Notion's API
      (<code>api.notion.com</code>) to create a page in the Notion database you've connected:
    </p>
    <ul>
      <li>The screenshot image, with your annotations flattened into it</li>
      <li>The web page's URL and title at the time of capture</li>
      <li>Your browser and OS (parsed from your browser's own user agent string), viewport size, and
        pixel ratio</li>
      <li>The title, severity, and notes you typed into the form</li>
      <li>The reporter name you set in the extension's Settings</li>
    </ul>
    <p>
      None of this is sent anywhere except directly to Notion's own API, using your own Notion
      connection. Bluenest does not operate any server that receives, stores, or has access to your
      screenshots, QA card content, or Notion data.
    </p>

    <h2>Notion connection (sign-in)</h2>
    <p>To connect the extension to Notion, you either:</p>
    <ul>
      <li>
        Use <strong>"Connect to Notion"</strong> (OAuth) — Notion's own authorization screen asks you to
        approve access and choose which pages/databases to share. A small backend service we operate
        (a Cloudflare Worker) exchanges the authorization code Notion provides for an access token and a
        refresh token, and stores that token pair, associated only with a random identifier your browser
        generates — never your name, email, or any identifying information. This service's only job is
        keeping that token valid; it never receives, reads, or stores your screenshots or QA card
        content, since those are sent directly from your browser to Notion, not through this service.
      </li>
      <li>
        Or paste a Notion internal integration token manually — this is stored only in your browser's
        local extension storage and is never sent anywhere except directly to Notion's API.
      </li>
    </ul>

    <h2>What's stored, and where</h2>
    <ul>
      <li><strong>In your browser</strong> (Chrome's local extension storage, never synced or sent
        elsewhere): your Notion connection token/identifier, your configured database, your reporter
        name, and your last-used annotation preferences.</li>
      <li><strong>On our Cloudflare Worker</strong>: only the OAuth token pair described above, keyed to
        a random per-install identifier — no screenshots, no QA card content, no identifying
        information.</li>
      <li><strong>Nowhere else.</strong> The extension includes no analytics, advertising, or tracking of
        any kind.</li>
    </ul>

    <h2>Data retention and deletion</h2>
    <p>
      A captured screenshot is held only in temporary browser session storage while you're editing it,
      and is cleared automatically once that's done. To remove your stored OAuth connection, disconnect
      in Notion directly (Notion's own Settings → Connections), or contact us to have the corresponding
      token pair deleted from the Worker.
    </p>

    <h2>Permissions this extension requests, and why</h2>
    <ul>
      <li><strong>activeTab / scripting</strong> — to inject the region-selection overlay only on the
        tab you're actively using, only when you trigger a capture.</li>
      <li><strong>storage</strong> — to save your settings locally in your browser.</li>
      <li><strong>notifications</strong> — to show a system notification if a page can't be captured
        (e.g. Chrome's own internal pages).</li>
      <li><strong>contextMenus</strong> — for the right-click capture options.</li>
      <li><strong>identity</strong> — to open Notion's OAuth consent screen.</li>
      <li><strong>Host access to api.notion.com and our Cloudflare Worker</strong> — required to send QA
        cards to Notion and to manage your OAuth connection, respectively.</li>
    </ul>

    <h2>Contact</h2>
    <p>
      Questions about this extension or this policy: <a href="mailto:umer@bluenestagency.com">umer@bluenestagency.com</a>.
    </p>
  </body>
</html>
`;

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
    if (request.method === "GET" && url.pathname === "/privacy") {
      return new Response(PRIVACY_POLICY_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
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
