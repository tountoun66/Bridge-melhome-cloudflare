const AUTH_BASE = "https://auth.melcloudhome.com";
const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;
const CLIENT_ID = "3g4d5l5kivuqi7oia68gib7uso";
const REDIRECT_URI = "https://auth.melcloudhome.com/signin-oidc-meu";
const SCOPES = "openid profile";
const USER_AGENT = "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px">${body}</body></html>`, { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
}

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

function cookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&") + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

async function startLogin() {
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // IMPORTANT: MELCloud requires PAR first. Do not call /authorize directly.
  const body = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  const par = await fetch(PAR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": USER_AGENT
    },
    body: body.toString()
  });

  const text = await par.text();
  if (!par.ok) throw new Error(`MELCloud PAR HTTP ${par.status}: ${text.slice(0, 500)}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Réponse PAR MELCloud invalide: ${text.slice(0, 500)}`); }
  if (!data.request_uri) throw new Error("MELCloud PAR n'a pas fourni de request_uri");

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("request_uri", data.request_uri);

  const session = encodeURIComponent(JSON.stringify({ state, nonce, verifier }));

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `melcloud_oauth_test=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

async function testToken(request) {
  const u = new URL(request.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const error = u.searchParams.get("error");
  const description = u.searchParams.get("error_description");

  if (error) return page(`<h1>❌ OAuth refusé</h1><pre>${esc(error)}</pre><pre>${esc(description || "")}</pre>`);
  if (!code) return page(`<h1>❌ Aucun code OAuth</h1><p>URL reçue : <code>${esc(u.toString())}</code></p>`, 400);

  const raw = cookie(request, "melcloud_oauth_test");
  if (!raw) return page(`<h1>❌ Session OAuth absente</h1><p>Le cookie PKCE n'est plus présent.</p>`, 400);

  let session;
  try { session = JSON.parse(raw); } catch { return page(`<h1>❌ Session OAuth invalide</h1>`, 400); }
  if (state !== session.state) return page(`<h1>❌ State invalide</h1>`, 400);

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: session.verifier
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": USER_AGENT
    },
    body: tokenBody.toString()
  });

  const result = await response.text();
  if (!response.ok) return page(`<h1>❌ Échange OAuth échoué</h1><p>HTTP ${response.status}</p><pre>${esc(result.slice(0, 1000))}</pre>`, 502);

  let tokens;
  try { tokens = JSON.parse(result); } catch { return page(`<h1>❌ Réponse token invalide</h1><pre>${esc(result.slice(0, 1000))}</pre>`, 502); }

  return page(`<h1>✅ OAuth MELCloud réussi</h1><p>Le code a été échangé avec succès.</p><p>access_token : <b>reçu</b></p><p>refresh_token : <b>${tokens.refresh_token ? "reçu" : "absent"}</b></p><p>expires_in : <b>${esc(tokens.expires_in ?? "?")}</b></p>`);
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    try {
      if (request.method === "GET" && u.pathname === "/") {
        return page(`<h1>❄️ MELCloud OAuth Test</h1><p>Flux officiel : PAR → authorize → Cognito → callback.</p><p><a href="/login"><button style="padding:12px 20px;font-size:16px">🔐 Se connecter à MELCloud</button></a></p>`);
      }
      if (request.method === "GET" && u.pathname === "/login") return await startLogin();
      if (request.method === "GET" && u.pathname === "/callback") return await testToken(request);
      if (request.method === "GET" && u.pathname === "/health") return Response.json({ ok: true, service: "melhome-oauth-test", flow: "PAR -> authorize -> Cognito" });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error("[MELCLOUD]", e);
      return page(`<h1>❌ Erreur</h1><pre>${esc(e?.stack || e?.message || String(e))}</pre>`, 500);
    }
  }
};