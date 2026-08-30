const MELCLOUD_HOME = "https://melcloudhome.com";
const AUTH_BASE = "https://auth.melcloudhome.com";
const API_BASE = "https://mobile.bff.melcloudhome.com";

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

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/* ============================================================
   SÉCURITÉ BASIC AUTH (VÉRIFICATION VIA LA BDD D1)
   ============================================================ */

async function checkBasicAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;
  const match = authHeader.match(/^Basic\s+(.*)$/);
  if (!match) return false;

  try {
    const credentials = atob(match[1]);
    const [user, pass] = credentials.split(":");

    const dbUser = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'admin_user'").first();
    const dbPass = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'admin_pass'").first();

    const validUser = dbUser ? dbUser.value : "admin";
    const validPass = dbPass ? dbPass.value : "admin";

    return user === validUser && pass === validPass;
  } catch {
    return false;
  }
}

function unauthorizedResponse() {
  return new Response("🔒 Accès restreint. Veuillez vous identifier.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Zone d\'Administration MELHome"',
      "Content-Type": "text/plain;charset=utf-8"
    }
  });
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

  // 3 heures en millisecondes
  const threeHoursInMs = 10800000;
  const isOlderThan3Hours = (Date.now() - oauth.updated_at) > threeHoursInMs;

  // Rafraîchir si expiré (ou expire dans < 5min) OU si généré il y a plus de 3h
  if (!oauth.expires_at || oauth.expires_at < Date.now() + 300000 || isOlderThan3Hours) {
    try {
      console.log("Rafraîchissement du token...");
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
  try { if (typeof response.headers.getSetCookie === "function") cookies = response.headers.getSetCookie(); } catch {}
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

function cookieHeader(jar) { return [...jar].map(([name, value]) => `${name}=${value}`).join("; "); }

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

async function diagnosticRequest(url, init, jar, diagnostics) {
  const response = await requestWithCookies(url, init, jar);
  diagnostics.push({
    url: url.replace(/([?&](?:code|state|nonce|request_uri|code_challenge|code_verifier|access_token|refresh_token)=)[^&]+/gi, "$1***"),
    method: init?.method || "GET",
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    setCookie: !!response.headers.get("set-cookie")
  });
  return response;
}

/* ============================================================
   OAUTH LOGIN FLOW
   ============================================================ */

async function loginToMelcloud(email, password, diagnostics) {
  const jar = new Map();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const par = await diagnosticRequest(PAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT_URI }).toString()
  }, jar, diagnostics);

  const parText = await par.text();
  if (!par.ok) throw new Error(`MELCloud PAR HTTP ${par.status}: ${parText.slice(0, 300)}`);
  
  let parData;
  try { parData = JSON.parse(parText); } catch { throw new Error("Réponse PAR MELCloud invalide"); }
  if (!parData.request_uri) throw new Error("MELCloud n'a pas fourni de request_uri");

  let currentUrl = `${AUTHORIZE_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&request_uri=${encodeURIComponent(parData.request_uri)}`;
  let init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } };
  
  let finalUrl = "", finalBody = "";

  for (let i = 0; i < 20; i++) {
    const response = await diagnosticRequest(currentUrl, init, jar, diagnostics);
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

    try {
      const parsedUrl = new URL(currentUrl);
      if (parsedUrl.pathname.toLowerCase() === "/redirect") {
        const redirectUri = parsedUrl.searchParams.get("RedirectUri");
        if (redirectUri) { currentUrl = new URL(redirectUri, currentUrl).toString(); init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } }; continue; }
      }
    } catch {}

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
      }
      currentUrl = form.action;
      init = { method: "POST", headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Accept: "text/html" }, body: form.data.toString() };
      continue;
    }
    finalUrl = currentUrl; break;
  }

  const authorizationCode = extractCode(finalUrl) || extractCode(finalBody);
  if (!authorizationCode) throw new Error("MELCloud n'a pas renvoyé de code OAuth");

  const tokenResponse = await diagnosticRequest(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: CLIENT_ID }).toString()
  }, jar, diagnostics);

  return await tokenResponse.json();
}

async function refreshToken(env, row) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: row.refresh_token }).toString()
  });
  const text = await response.text();
  let tokens;
  try { tokens = JSON.parse(text); } catch(e) { throw new Error(`Refresh token a échoué`); }
  if (!tokens.refresh_token) tokens.refresh_token = row.refresh_token;
  await saveOAuth(env, tokens);
  return tokens;
}

/* ============================================================
   MAPPERS DES ÉTATS (LECTURE)
   ============================================================ */

function getSetting(clim, keys) {
  const containers = [];
  if (Array.isArray(clim.settings)) containers.push(clim.settings);
  if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);

  for (const container of containers) {
    for (const item of container) {
      const itemName = String(item.name || item.Name || '').toLowerCase();
      if (keys.some(k => k.toLowerCase() === itemName)) {
        if (item.value !== undefined && item.value !== null) return item.value;
      }
    }
  }
  return null;
}

function isPoweredOn(clim) {
  const val = getSetting(clim, ['power', 'Power']);
  return val === true || String(val).toLowerCase() === 'true';
}

function getRoomTemp(clim) {
  const val = getSetting(clim, ['roomTemperature', 'RoomTemperature']);
  const num = parseFloat(val);
  return Number.isFinite(num) && num > 0 && num < 60 ? num : 20.0;
}

function getTemp(clim) {
  const val = getSetting(clim, ['setTemperature', 'SetTemperature']);
  const num = parseFloat(val);
  return Number.isFinite(num) && num > 0 && num < 60 ? num : 20.0;
}

function getGoogleMode(clim) {
  if (!isPoweredOn(clim)) return 'off';
  const mode = String(getSetting(clim, ['operationMode', 'OperationMode']) || 'Automatic').toLowerCase();
  if (mode.includes('cool')) return 'cool';
  if (mode.includes('heat')) return 'heat';
  if (mode.includes('dry')) return 'dry';
  if (mode.includes('fan')) return 'fan-only';
  return 'auto';
}

function getGoogleFanSpeed(clim) {
  const set = getSetting(clim, ['SetFanSpeed', 'setFanSpeed', 'FanSpeed', 'fanSpeed']);
  
  const setStr = set !== undefined && set !== null ? String(set).trim().toLowerCase() : '';
  if (setStr.includes('auto') || setStr.includes('automatic') || setStr === '0') {
    return 'Auto';
  }

  const val = (set !== undefined && set !== null) ? set : getSetting(clim, ['ActualFanSpeed', 'actualFanSpeed']);
  if (val === undefined || val === null) return 'Auto';
  
  if (val === 1 || val === '1') return 'One';
  if (val === 2 || val === '2') return 'Two';
  if (val === 3 || val === '3') return 'Three';
  if (val === 4 || val === '4') return 'Four';
  if (val === 5 || val === '5') return 'Five';
  
  const str = String(val).trim().toLowerCase();
  
  if (str === 'auto' || str === 'automatic' || str === '0') return 'Auto';
  if (str.includes('one') || str === 'faible') return 'One';
  if (str.includes('two')) return 'Two';
  if (str.includes('three') || str === 'moyenne') return 'Three';
  if (str.includes('four')) return 'Four';
  if (str.includes('five') || str === '5' || str === 'forte' || str === 'max') return 'Five';
  
  return 'Auto';
}

/* ============================================================
   WORKER PRINCIPAL ET CRON JOB
   ============================================================ */

export default {
  // ROUTER HTTP (Requêtes Web et Google Home)
  async fetch(request, env) {
    const url = new URL(request.url);

    // 🔒 PROTECTION DES PAGES D'ADMINISTRATION VIA LA BASE DE DONNÉES D1
    const adminRoutes = ["/", "/setup", "/devices", "/api/test-command"];
    if (adminRoutes.includes(url.pathname)) {
      if (!(await checkBasicAuth(request, env))) {
        return unauthorizedResponse();
      }
    }

    try {
      /* --- ACCUEIL --- */
      if (request.method === "GET" && url.pathname === "/") {
        const oauth = await getOAuth(env);
        return html(`
<h1>❄️ MELHome Cloudflare Bridge</h1>
<p>Liaison Google Home : <b>${oauth?.refresh_token ? "✅ PRÊTE" : "❌ ABSENTE"}</b></p>
<div style="display:flex;gap:15px;margin-top:20px;">
  <a href="/setup" style="padding:10px 15px;background:#eee;text-decoration:none;border-radius:5px;color:black;">🔐 Configurer MELCloud</a>
  <a href="/devices" style="padding:10px 15px;background:#005cff;text-decoration:none;border-radius:5px;color:white;font-weight:bold;">🌡️ Voir mes Clims</a>
</div>
`);
      }

      /* --- SETUP --- */
      if (request.method === "GET" && url.pathname === "/setup") {
        return html(`
<h1>🔐 Connexion MELCloud</h1>
<form method="post">
<input name="email" type="email" placeholder="E-mail" required style="width:100%;padding:10px"><br><br>
<input name="password" type="password" placeholder="Mot de passe" required style="width:100%;padding:10px"><br><br>
<button style="padding:12px 20px">Se connecter</button>
</form>
`);
      }

      if (request.method === "POST" && url.pathname === "/setup") {
        const form = await request.formData();
        const diagnostics = [];
        try {
          const tokens = await loginToMelcloud(form.get("email").trim(), form.get("password"), diagnostics);
          await saveOAuth(env, tokens);
          return html(`<h1>✅ Connecté !</h1><p><a href="/devices">🌡️ Voir mes Climatiseurs</a></p>`);
        } catch (error) {
          return html(`<h1>❌ Erreur</h1><pre>${esc(error.message)}</pre>
          <h3>Diagnostic :</h3><pre style="background:#f5f5f5;padding:10px;font-size:12px;">${esc(JSON.stringify(diagnostics, null, 2))}</pre>
          <a href="/setup">Réessayer</a>`, 400);
        }
      }

      /* --- AFFICHER ET PILOTER LES CLIMS (DASHBOARD) --- */
      if (request.method === "GET" && url.pathname === "/devices") {
        const token = await getValidAccessToken(env);
        if (!token) return html(`<h1>❌ Non connecté</h1><p><a href="/setup">Se connecter</a></p>`);
        
        const res = await fetch(`${API_BASE}/context`, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json", "User-Agent": USER_AGENT }
        });
        const data = await res.json();
        const units = data.buildings?.[0]?.airToAirUnits || [];
        
        let htmlList = "<h1>🌡️ Panneau de contrôle des clims</h1><ul style='list-style:none;padding:0;'>";
        for (const u of units) {
          const climId = u.id ?? u.ID;
          htmlList += `<li style="background:#f5f5f5;margin-bottom:10px;padding:15px;border-radius:5px;">
            <b style="font-size:18px;">${esc(u.givenDisplayName)}</b> - ${isPoweredOn(u) ? "✅ Allumé" : "💤 Éteint"}<br>
            <span style="color:#555">Mode : ${getGoogleMode(u)} | Consigne : ${getTemp(u)}°C | Pièce : ${getRoomTemp(u)}°C | Vent : ${getGoogleFanSpeed(u)}</span><br>
            
            <details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:#005cff;">🔍 Voir le JSON brut de cette clim</summary>
            <pre style="background:#fff;padding:10px;font-size:11px;overflow:auto;max-height:150px;">${esc(JSON.stringify(u, null, 2))}</pre>
            </details><br>
            
            <button id="btn-on-${climId}" onclick="sendCmd('${climId}', true)" style="padding:8px 12px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;margin-right:10px;">🟢 Allumer</button>
            <button id="btn-off-${climId}" onclick="sendCmd('${climId}', false)" style="padding:8px 12px;background:#F44336;color:white;border:none;border-radius:4px;cursor:pointer;">🔴 Éteindre</button>
          </li>`;
        }
        htmlList += `</ul><p><a href="/">⬅️ Retour à l'accueil</a></p>
        
        <script>
        async function sendCmd(id, power) {
          const btnId = power ? 'btn-on-'+id : 'btn-off-'+id;
          const btn = document.getElementById(btnId);
          const originalText = btn.innerText;
          btn.innerText = "⏳ Envoi...";
          
          try {
            const res = await fetch('/api/test-command', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ id, payload: { power, inStandbyMode: null } })
            });
            const data = await res.json();
            
            if(data.ok) {
               alert("✅ Succès !");
            } else {
               alert("❌ Erreur " + data.status);
            }
          } catch(e) {
            alert("Erreur locale : " + e.message);
          }
          btn.innerText = originalText;
        }
        </script>
        `;
        return html(htmlList);
      }

      /* --- ROUTE DE TEST DES COMMANDES (BACKEND) --- */
      if (request.method === "POST" && url.pathname === "/api/test-command") {
        const token = await getValidAccessToken(env);
        if (!token) return Response.json({ ok: false, status: 401, response: "Non connecté" });
        
        const body = await request.json();
        
        const apiResponse = await fetch(`${API_BASE}/context`, {
          headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json", "User-Agent": USER_AGENT }
        });
        const contextData = await apiResponse.json();
        const clims = contextData.buildings?.[0]?.airToAirUnits || [];
        const targetClim = clims.find(c => String(c.id ?? c.ID) === String(body.id));
        
        if (targetClim) {
           body.payload.inStandbyMode = getSetting(targetClim, ['inStandbyMode', 'InStandbyMode']) === true ? true : null;
        }

        const urlToCall = `${API_BASE}/monitor/ataunit/${encodeURIComponent(body.id)}`;
        
        const res = await fetch(urlToCall, {
          method: "PUT",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify(body.payload)
        });
        
        const text = await res.text();
        return Response.json({ ok: res.ok, status: res.status, url: urlToCall, response: text });
      }

      /* --- GOOGLE HOME : ASSOCIATION OAUTH --- */
      if (request.method === "GET" && url.pathname === "/google/auth") {
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        return html(`
<div style="text-align:center; margin-top:50px;">
  <h2>Associer MELHome à Google</h2>
  <form method="POST" action="/google/login">
    <input type="hidden" name="redirect_uri" value="${redirectUri}" />
    <input type="hidden" name="state" value="${state}" />
    <p>Code PIN de sécurité :</p>
    <input type="password" name="pin" placeholder="Code PIN" style="padding:10px;font-size:20px;text-align:center;width:150px;letter-spacing:3px" required />
    <br><br>
    <button type="submit" style="padding:12px 24px;background:#005cff;color:white;border:none;border-radius:5px;font-size:16px;">Associer</button>
  </form>
</div>`);
      }

      if (request.method === "POST" && url.pathname === "/google/login") {
        const formData = await request.formData();
        if (formData.get("pin") !== GOOGLE_HOME_PIN) {
          return html(`<h2 style="color:red;text-align:center">Code PIN incorrect</h2><p style="text-align:center"><a href="javascript:history.back()">Réessayer</a></p>`);
        }
        const separator = formData.get("redirect_uri").includes("?") ? "&" : "?";
        return Response.redirect(`${formData.get("redirect_uri")}${separator}code=ghome_${crypto.randomUUID()}&state=${encodeURIComponent(formData.get("state"))}`, 302);
      }

      if ((request.method === "POST" || request.method === "GET") && url.pathname === "/google/token") {
        return Response.json({ access_token: "melhome-google-permanent-token", token_type: "Bearer", expires_in: 31536000 });
      }

      /* --- GOOGLE HOME : FULFILLMENT --- */
      if (request.method === "POST" && url.pathname === "/google/fulfillment") {
        const body = await request.json();
        const requestId = body.requestId;
        const intent = body.inputs?.[0]?.intent;
        
        const melToken = await getValidAccessToken(env);
        if (!melToken) return Response.json({ requestId, payload: { errorCode: "authFailure" } });

        const apiResponse = await fetch(`${API_BASE}/context`, {
          headers: { "Authorization": `Bearer ${melToken}`, "Accept": "application/json", "User-Agent": USER_AGENT }
        });
        const contextData = await apiResponse.json();
        const clims = contextData.buildings?.[0]?.airToAirUnits || [];

        /* -- SYNC -- */
        if (intent === "action.devices.SYNC") {
          const googleDevices = clims.map(clim => ({
            id: String(clim.id ?? clim.ID),
            type: "action.devices.types.THERMOSTAT",
            traits: ["action.devices.traits.TemperatureSetting", "action.devices.traits.FanSpeed"],
            name: { name: clim.givenDisplayName || clim.GivenDisplayName || "Climatiseur" },
            willReportState: false,
            attributes: {
              availableThermostatModes: "off,on,heat,cool,dry,fan-only,auto",
              thermostatTemperatureUnit: "C",
              supportsFanSpeedPercent: false,
              commandOnlyFanSpeed: false,
              availableFanSpeeds: {
                speeds: [
                  { speed_name: "Auto", speed_values: [{ lang: "fr", speed_synonym: ["Auto", "Automatique"] }, { lang: "en", speed_synonym: ["Auto", "Automatic"] }] },
                  { speed_name: "One", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 1", "1", "Un", "Faible"] }, { lang: "en", speed_synonym: ["Speed 1", "1", "Low"] }] },
                  { speed_name: "Two", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 2", "2", "Deux"] }, { lang: "en", speed_synonym: ["Speed 2", "2"] }] },
                  { speed_name: "Three", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 3", "3", "Trois", "Moyenne"] }, { lang: "en", speed_synonym: ["Speed 3", "3", "Medium"] }] },
                  { speed_name: "Four", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 4", "4", "Quatre"] }, { lang: "en", speed_synonym: ["Speed 4", "4"] }] },
                  { speed_name: "Five", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 5", "5", "Cinq", "Forte", "Max"] }, { lang: "en", speed_synonym: ["Speed 5", "5", "High", "Max"] }] }
                ],
                ordered: true
              }
            }
          }));
          return Response.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices } });
        }

        /* -- QUERY -- */
        if (intent === "action.devices.QUERY") {
          const devicesState = {};
          clims.forEach(clim => {
            const id = String(clim.id ?? clim.ID);
            devicesState[id] = {
              online: true, status: "SUCCESS", thermostatMode: getGoogleMode(clim),
              thermostatTemperatureSetpoint: getTemp(clim), thermostatTemperatureAmbient: getRoomTemp(clim), currentFanSpeedSetting: getGoogleFanSpeed(clim)
            };
          });
          return Response.json({ requestId, payload: { devices: devicesState } });
        }

        /* -- EXECUTE -- */
        if (intent === "action.devices.EXECUTE") {
          const commands = body.inputs?.[0]?.payload?.commands || [];
          const responseCommands = [];

          for (const command of commands) {
            for (const device of command.devices || []) {
              const climId = String(device.id);
              const currentDeviceData = clims.find(c => String(c.id ?? c.ID) === climId);
              if (!currentDeviceData) continue;

              // CORRECTION IMPORTANTE : Sauvegarde stricte de la vitesse numérique (0 au lieu de "Auto")
              let currentFan = getSetting(currentDeviceData, ['setFanSpeed', 'SetFanSpeed', 'ActualFanSpeed']);
              let currentVaneV = getSetting(currentDeviceData, ['vaneVerticalDirection', 'VaneVerticalDirection']);
              let currentVaneH = getSetting(currentDeviceData, ['vaneHorizontalDirection', 'VaneHorizontalDirection']);

              let payloadJson = {
                power: isPoweredOn(currentDeviceData),
                operationMode: getSetting(currentDeviceData, ['operationMode', 'OperationMode']) ?? "Cool",
                setTemperature: getTemp(currentDeviceData),
                setFanSpeed: (currentFan !== null && currentFan !== undefined) ? currentFan : 0,
                vaneVerticalDirection: (currentVaneV !== null && currentVaneV !== undefined) ? currentVaneV : "Auto",
                vaneHorizontalDirection: (currentVaneH !== null && currentVaneH !== undefined) ? currentVaneH : "Auto",
                temperatureIncrementOverride: null,
                inStandbyMode: getSetting(currentDeviceData, ['inStandbyMode', 'InStandbyMode']) === true ? true : null
              };

              const updatedStates = {
                online: true, thermostatMode: getGoogleMode(currentDeviceData),
                thermostatTemperatureSetpoint: getTemp(currentDeviceData), currentFanSpeedSetting: getGoogleFanSpeed(currentDeviceData)
              };

              for (const exec of command.execution || []) {
                if (exec.command === "action.devices.commands.OnOff") {
                  payloadJson.power = Boolean(exec.params?.on);
                  updatedStates.thermostatMode = payloadJson.power ? "auto" : "off";
                }
                if (exec.command === "action.devices.commands.ThermostatTemperatureSetpoint") {
                  payloadJson.setTemperature = exec.params?.thermostatTemperatureSetpoint;
                  updatedStates.thermostatTemperatureSetpoint = payloadJson.setTemperature;
                }
                if (exec.command === "action.devices.commands.ThermostatSetMode") {
                  const mode = exec.params?.thermostatMode;
                  updatedStates.thermostatMode = mode;
                  if (mode === "off") {
                    payloadJson.power = false;
                  } else {
                    payloadJson.power = true;
                    if (mode === "cool") payloadJson.operationMode = "Cool";
                    else if (mode === "heat") payloadJson.operationMode = "Heat";
                    else if (mode === "dry") payloadJson.operationMode = "Dry";
                    else if (mode === "fan-only") payloadJson.operationMode = "Fan";
                    else if (mode === "auto" || mode === "on") payloadJson.operationMode = "Automatic";
                  }
                }
                // CORRECTION IMPORTANTE : Traduction des vitesses Google vers des chiffres pour MELCloud
                if (exec.command === "action.devices.commands.SetFanSpeed") {
                  const ghSpeed = exec.params?.fanSpeed;
                  updatedStates.currentFanSpeedSetting = ghSpeed;
                  
                  let melSpeed = 0; // Auto par défaut
                  if (ghSpeed === "One") melSpeed = 1;
                  else if (ghSpeed === "Two") melSpeed = 2;
                  else if (ghSpeed === "Three") melSpeed = 3;
                  else if (ghSpeed === "Four") melSpeed = 4;
                  else if (ghSpeed === "Five") melSpeed = 5;
                  else if (ghSpeed === "Auto") melSpeed = 0;
                  
                  payloadJson.setFanSpeed = melSpeed;
                }
              }

              payloadJson = Object.fromEntries(Object.entries(payloadJson).filter(([_, v]) => v !== null));

              const execRes = await fetch(`${API_BASE}/monitor/ataunit/${encodeURIComponent(climId)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${melToken}`, "User-Agent": USER_AGENT },
                body: JSON.stringify(payloadJson)
              });

              if (execRes.ok) {
                responseCommands.push({ ids: [climId], status: "SUCCESS", states: updatedStates });
              } else {
                responseCommands.push({ ids: [climId], status: "ERROR", errorCode: "hardError" });
              }
            }
          }
          return Response.json({ requestId, payload: { commands: responseCommands } });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("[WORKER ERROR]", error);
      return html(`<h1>❌ Erreur interne</h1><pre>${esc(error.stack || error.message)}</pre>`, 500);
    }
  },

  // TÂCHE DE FOND (CRON TRIGGER)
  async scheduled(event, env, ctx) {
    console.log("Exécution de la tâche planifiée Cron Trigger...");
    const oauth = await getOAuth(env);
    if (oauth?.refresh_token) {
      try {
        await refreshToken(env, oauth);
        console.log("Token rafraîchi automatiquement avec succès en arrière-plan.");
      } catch (e) {
        console.error("Erreur lors du rafraîchissement automatique (Cron)", e);
      }
    }
  }
};
