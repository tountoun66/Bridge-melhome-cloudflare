const MELCLOUD_HOME = "https://melcloudhome.com";
const AUTH_BASE = "https://auth.melcloudhome.com";

const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;

const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES = "openid profile email offline_access IdentityServerApi";

const USER_AGENT = "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";
const GOOGLE_HOME_PIN = "1234";

function html(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MELHome Bridge</title>
</head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px">
${body}
</body>
</html>`,
    { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } }
  );
}

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/* ============================================================
   D1 (BASE DE DONNÉES)
   ============================================================ */

async function getOAuth(env) {
  if (!env.DB) throw new Error("Binding D1 'DB' absent");
  return await env.DB.prepare("SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1").first();
}

async function saveOAuth(env, tokens) {
  if (!env.DB) throw new Error("Binding D1 'DB' absent");
  if (!tokens?.refresh_token) throw new Error("MELCloud n'a pas fourni de refresh_token");

  const now = Date.now();
  const expiresAt = tokens.expires_at || now + Number(tokens.expires_in || 3600) * 1000;

  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), tokens.access_token || null, tokens.refresh_token, expiresAt, now, now).run();
}

async function getValidAccessToken(env) {
  let oauth = await getOAuth(env);
  if (!oauth?.refresh_token) return null;

  if (!oauth.expires_at || oauth.expires_at < Date.now() + 300000) {
    try {
      oauth = await refreshToken(env, oauth);
    } catch (e) {
      console.error("Erreur refresh token", e);
      return null;
    }
  }
  return oauth.access_token;
}

/* ============================================================
   COOKIE JAR & HTTP
   ============================================================ */

function addCookies(jar, response) {
  let cookies = [];
  try {
    if (typeof response.headers.getSetCookie === "function") cookies = response.headers.getSetCookie();
  } catch {}
  if (!cookies.length) {
    const raw = response.headers.get("set-cookie");
    if (raw) cookies = raw.split(/,(?=\s*[^;,=\s]+=[^;,]+)/);
  }
  for (const cookie of cookies) {
    const part = cookie.split(";", 1)[0];
    const index = part.indexOf("=");
    if (index <= 0) continue;
    jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function requestWithCookies(url, init, jar) {
  const headers = new Headers(init?.headers || {});
  const cookies = cookieHeader(jar);
  if (cookies) headers.set("Cookie", cookies);
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  addCookies(jar, response);
  return response;
}

function extractCode(value) {
  if (!value) return null;
  const match = String(value).match(/[?&]code=([^&\s"'<>]+)/i);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function extractForm(body, baseUrl) {
  if (!body) return null;
  const match = String(body).match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (!match) return null;
  const action = new URL(match[1].replace(/&amp;/g, "&"), baseUrl).toString();
  const data = new URLSearchParams();
  for (const item of match[2].matchAll(/<input[^>]*>/gi)) {
    const name = item[0].match(/name=["']([^"']+)["']/i)?.[1];
    const value = item[0].match(/value=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) data.set(name, value);
  }
  return { action, data };
}

/* ============================================================
   OAUTH LOGIN FLOW
   ============================================================ */

async function loginToMelcloud(email, password, diagnostics) {
  const jar = new Map();

  /* PKCE & PAR */
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const par = await requestWithCookies(PAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT_URI }).toString()
  }, jar);

  const parText = await par.text();
  if (!par.ok) throw new Error(`MELCloud PAR HTTP ${par.status}: ${parText.slice(0, 300)}`);
  
  let parData;
  try { parData = JSON.parse(parText); } catch { throw new Error("Réponse PAR MELCloud invalide (HTML reçu)"); }
  if (!parData.request_uri) throw new Error("MELCloud n'a pas fourni de request_uri");

  /* AUTHORIZE (Simplifié pour la lisibilité, l'auto-soumission Cognito reste) */
  let currentUrl = `${AUTHORIZE_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
  let init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } };
  
  let finalUrl = "";
  let finalBody = "";

  for (let i = 0; i < 20; i++) {
    const response = await requestWithCookies(currentUrl, init, jar);
    const location = response.headers.get("location");

    if (location) {
      const nextUrl = new URL(location, currentUrl).toString();
      if (/^melcloud(?:home)?:\/\//i.test(nextUrl)) { finalUrl = nextUrl; break; }
      currentUrl = nextUrl; init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } };
      continue;
    }

    finalBody = await response.text();
    const code = extractCode(currentUrl) || extractCode(finalBody);
    if (code) { finalUrl = currentUrl; break; }

    const metaMatch = finalBody.match(/content=["'][0-9]+;\s*url=["']?([^"'>]+)["']?/i);
    if (metaMatch) {
      currentUrl = new URL(metaMatch[1].replace(/&amp;/g, "&"), currentUrl).toString();
      init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } };
      continue;
    }

    const form = extractForm(finalBody, currentUrl);
    if (form) {
      if (currentUrl.includes("amazoncognito.com")) {
        form.data.set([...form.data.keys()].find(k => /^(username|email|login)$/i.test(k)) || "username", email);
        form.data.set([...form.data.keys()].find(k => /password/i.test(k)) || "password", password);
        currentUrl = form.action;
        init = { method: "POST", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Accept: "text/html" }, body: form.data.toString() };
        continue;
      }
      currentUrl = form.action;
      init = { method: "POST", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Accept: "text/html" }, body: form.data.toString() };
      continue;
    }
    finalUrl = currentUrl; break;
  }

  const authorizationCode = extractCode(finalUrl) || extractCode(finalBody);
  if (!authorizationCode) throw new Error("MELCloud n'a pas renvoyé de code OAuth");

  const tokenResponse = await requestWithCookies(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: CLIENT_ID }).toString()
  }, jar);

  const tokenText = await tokenResponse.text();
  let tokens;
  try { tokens = JSON.parse(tokenText); } catch { throw new Error(`Réponse token invalide (HTML reçu au lieu de JSON) : ${tokenText.slice(0,200)}`); }
  return tokens;
}

async function refreshToken(env, row) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: row.refresh_token }).toString()
  });

  const text = await response.text();
  let tokens;
  try { 
    tokens = JSON.parse(text); 
  } catch(e) { 
    throw new Error(`Le refresh token a reçu du HTML au lieu de JSON : ${text.slice(0,200)}`); 
  }
  
  if (!tokens.refresh_token) tokens.refresh_token = row.refresh_token;
  await saveOAuth(env, tokens);
  return tokens;
}

/* ============================================================
   WORKER PRINCIPAL (ROUTER)
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      /* --- ACCUEIL --- */
      if (request.method === "GET" && url.pathname === "/") {
        const oauth = await getOAuth(env);
        return html(`
<h1>❄️ MELHome Cloudflare Bridge</h1>
<p>Token MELCloud : <b>${oauth?.refresh_token ? "✅ CONNECTÉ" : "❌ ABSENT"}</b></p>
<div style="display:flex;gap:15px;margin-top:20px;">
  <a href="/setup" style="padding:10px 15px;background:#eee;text-decoration:none;border-radius:5px;color:black;">🔐 Configurer MELCloud</a>
  <a href="/devices" style="padding:10px 15px;background:#005cff;text-decoration:none;border-radius:5px;color:white;font-weight:bold;">🌡️ Tester les Clims</a>
</div>
`);
      }

      /* --- SETUP --- */
      if (request.method === "GET" && url.pathname === "/setup") {
        return html(`
<h1>🔐 Connexion MELCloud</h1>
<form method="post">
<input name="email" type="email" autocomplete="username" placeholder="E-mail" required style="width:100%;padding:10px"><br><br>
<input name="password" type="password" autocomplete="current-password" placeholder="Mot de passe" required style="width:100%;padding:10px"><br><br>
<button style="padding:12px 20px">Se connecter</button>
</form>
`);
      }

      if (request.method === "POST" && url.pathname === "/setup") {
        const form = await request.formData();
        try {
          const tokens = await loginToMelcloud(form.get("email").trim(), form.get("password"));
          await saveOAuth(env, tokens);
          return html(`<h1>✅ Token MELCloud récupéré</h1><p><a href="/devices">🌡️ Tester la connexion aux clims</a></p>`);
        } catch (error) {
          return html(`<h1>❌ Connexion impossible</h1><pre style="background:#ffebee;padding:15px;color:red;">${esc(error.message)}</pre><a href="/setup">Réessayer</a>`, 400);
        }
      }

      /* --- SCANNER SÉCURISÉ DES CLIMS --- */
      if (request.method === "GET" && url.pathname === "/devices") {
        const token = await getValidAccessToken(env);
        if (!token) return html(`<h1>❌ Non connecté à MELCloud (ou Token expiré)</h1><p><a href="/setup">Se reconnecter</a></p>`);
        
        const endpoints = [
          "https://api.melcloudhome.com/api/v1/context",
          "https://melcloudhome.com/api/v1/context",
          "https://melcloudhome.com/api/context",
          "https://melcloudhome.com/api/user/context"
        ];

        let results = "<h1>🔍 Recherche du bon endpoint...</h1>";
        
        for (const endpoint of endpoints) {
          try {
            const res = await fetch(endpoint, {
              headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json", "User-Agent": USER_AGENT },
              redirect: "manual" // Empêche les redirections vicieuses HTML
            });

            const text = await res.text();
            let isJson = false;
            let preview = text.substring(0, 300);

            try { JSON.parse(text); isJson = true; } catch (e) {}

            results += `
            <div style="margin-bottom: 20px; padding: 15px; border-radius: 5px; border: 1px solid #ccc; background: ${res.status === 200 && isJson ? '#e8f5e9' : '#fff'}">
              <h3 style="margin-top:0">${endpoint}</h3>
              <p><b>Statut HTTP :</b> ${res.status}</p>
              <p><b>Format du retour :</b> ${isJson ? "✅ JSON" : "❌ C'est du HTML (ou vide)"}</p>
              <pre style="background:#f5f5f5; padding:10px; overflow:auto; max-height:150px;">${esc(preview)}</pre>
            </div>`;
          } catch (err) {
             results += `<div style="margin-bottom: 20px; padding: 15px; border-radius: 5px; background: #ffebee;"><h3 style="margin-top:0">${endpoint}</h3><p>Erreur réseau : ${err.message}</p></div>`;
          }
        }

        results += `<p><a href="/">⬅️ Retour</a></p>`;
        return html(results);
      }

      /* --- ROUTES GOOGLE HOME BOUDÉES POUR LE MOMENT --- */
      // Les routes Google Home sont préservées ici, prêtes à l'emploi une fois le bon endpoint trouvé
      if (url.pathname.startsWith("/google/")) {
         return html(`<h1>🛠️ En attente de configuration</h1><p>Nous devons d'abord trouver le bon endpoint sur /devices avant de lancer Google Home.</p>`);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("[WORKER ERROR]", error);
      return html(`<h1>❌ Erreur Critique du Worker</h1><pre>${esc(error.stack || error.message)}</pre>`, 500);
    }
  }
};
