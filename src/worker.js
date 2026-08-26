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

// 💡 L'API SECRÈTE DE L'APPLICATION MOBILE MITSUBISHI !
const API_BASE = "https://mobile.bff.melcloudhome.com";

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

async function diagnosticRequest(url, init, jar, diagnostics) {
  const response = await requestWithCookies(url, init, jar);
  diagnostics.push({
    url: maskUrl(url),
    method: init?.method || "GET",
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: maskUrl(response.headers.get("location")),
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
  
  let finalUrl = "";
  let finalBody = "";

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
        if (redirectUri) {
          currentUrl = new URL(redirectUri, currentUrl).toString();
          init = { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } };
          continue;
        }
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
        currentUrl = form.action;
        init = { method: "POST", headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Accept: "text/html" }, body: form.data.toString() };
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

  const tokenResponse = await diagnosticRequest(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "authorization_code", code: authorizationCode, redirect_uri: REDIRECT_URI, code_verifier: verifier, client_id: CLIENT_ID }).toString()
  }, jar, diagnostics);

  const tokenText = await tokenResponse.text();
  let tokens;
  try { tokens = JSON.parse(tokenText); } catch { throw new Error(`Réponse token invalide: ${tokenText.slice(0,200)}`); }
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
  try { tokens = JSON.parse(text); } catch(e) { throw new Error(`Le refresh token a échoué : ${text.slice(0,200)}`); }
  
  if (!tokens.refresh_token) tokens.refresh_token = row.refresh_token;
  await saveOAuth(env, tokens);
  return tokens;
}

/* ============================================================
   GOOGLE HOME MAPPERS
   ============================================================ */

function getSetting(clim, keys) {
  for (const key of keys) {
    if (clim[key] !== undefined && clim[key] !== null) return clim[key];
  }
  const containers = [];
  if (Array.isArray(clim.settings)) containers.push(clim.settings);
  if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);

  for (const container of containers) {
    for (const item of container) {
      const itemName = String(item.name || item.Name || '').toLowerCase();
      if (keys.some(k => k.toLowerCase() === itemName)) {
        if (item.value !== undefined && item.value !== null) return item.value;
        if (item.Value !== undefined && item.Value !== null) return item.Value;
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
  const val = getSetting(clim, ['roomTemperature', 'RoomTemperature', 'indoorTemperature', 'IndoorTemperature']);
  const num = parseFloat(val);
  return Number.isFinite(num) && num > 0 && num < 60 ? num : 20.0;
}

function getTemp(clim) {
  const val = getSetting(clim, ['setTemperature', 'SetTemperature', 'targetTemperature', 'TargetTemperature', 'defaultTemperature']);
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
  const val = getSetting(clim, ['setFanSpeed', 'SetFanSpeed', 'fanSpeed', 'FanSpeed']);
  if (val === undefined || val === null) return 'Auto';
  const str = String(val).toLowerCase();
  if (str.includes('one') || str === '1') return 'One';
  if (str.includes('two') || str === '2') return 'Two';
  if (str.includes('three') || str === '3') return 'Three';
  if (str.includes('four') || str === '4') return 'Four';
  if (str.includes('five') || str === '5') return 'Five';
  return 'Auto';
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
        const diagnostics = [];
        try {
          const tokens = await loginToMelcloud(form.get("email").trim(), form.get("password"), diagnostics);
          await saveOAuth(env, tokens);
          return html(`<h1>✅ Token MELCloud récupéré</h1><p><a href="/devices">🌡️ Tester la connexion aux clims</a></p>`);
        } catch (error) {
          return html(`<h1>❌ Connexion impossible</h1><pre style="background:#ffebee;padding:15px;color:red;">${esc(error.message)}</pre>
          <h3>Diagnostic :</h3><pre style="background:#f5f5f5;padding:10px;font-size:12px;">${esc(JSON.stringify(diagnostics, null, 2))}</pre>
          <a href="/setup">Réessayer</a>`, 400);
        }
      }

      /* --- TESTER L'API MOBILE --- */
      if (request.method === "GET" && url.pathname === "/devices") {
        const token = await getValidAccessToken(env);
        if (!token) return html(`<h1>❌ Non connecté (ou Token expiré)</h1><p><a href="/setup">Se reconnecter</a></p>`);
        
        const endpoint = `${API_BASE}/context`;
        
        try {
          const res = await fetch(endpoint, {
            headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json", "User-Agent": USER_AGENT },
            redirect: "manual"
          });

          const text = await res.text();
          let isJson = false;
          try { JSON.parse(text); isJson = true; } catch (e) {}

          return html(`
          <h1>🔍 Test de l'API Mobile MELCloud Home</h1>
          <div style="padding: 15px; border-radius: 5px; border: 1px solid #ccc; background: ${res.status === 200 && isJson ? '#e8f5e9' : '#ffebee'}">
            <h3 style="margin-top:0">${endpoint}</h3>
            <p><b>Statut HTTP :</b> ${res.status}</p>
            <p><b>Format du retour :</b> ${isJson ? "✅ JSON détecté (C'est le bon !)" : "❌ HTML ou Erreur"}</p>
            <pre style="background:#fff; padding:10px; overflow:auto; max-height:400px; font-size:13px;">${esc(text)}</pre>
          </div>
          <p><a href="/">⬅️ Retour</a></p>`);
        } catch (err) {
           return html(`<h1>❌ Erreur réseau</h1><p>${err.message}</p>`);
        }
      }

      /* --- GOOGLE HOME : ASSOCIATION OAUTH --- */
      if (request.method === "GET" && url.pathname === "/google/auth") {
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        return html(`
<div style="text-align:center; margin-top:50px;">
  <h2>Associer MELHome à Google Home</h2>
  <form method="POST" action="/google/login">
    <input type="hidden" name="redirect_uri" value="${redirectUri}" />
    <input type="hidden" name="state" value="${state}" />
    <p>Code PIN de sécurité :</p>
    <input type="password" name="pin" placeholder="Code PIN" style="padding:10px;font-size:20px;text-align:center;width:150px;letter-spacing:3px" required />
    <br><br>
    <button type="submit" style="padding:12px 24px;background:#005cff;color:white;border:none;border-radius:5px;font-size:16px;cursor:pointer;">Associer</button>
  </form>
</div>`);
      }

      if (request.method === "POST" && url.pathname === "/google/login") {
        const formData = await request.formData();
        const pin = formData.get("pin");
        const redirect_uri = formData.get("redirect_uri");
        const state = formData.get("state");

        if (pin !== GOOGLE_HOME_PIN) {
          return html(`<h2 style="color:red;text-align:center">Code PIN incorrect</h2><p style="text-align:center"><a href="javascript:history.back()">Réessayer</a></p>`);
        }
        const authCode = `ghome_${crypto.randomUUID()}`;
        const separator = redirect_uri.includes("?") ? "&" : "?";
        return Response.redirect(`${redirect_uri}${separator}code=${authCode}&state=${encodeURIComponent(state)}`, 302);
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

        // Appel à la véritable API Mobile
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

              const payloadJson = {
                power: null, operationMode: null, setFanSpeed: null, setTemperature: null,
                vaneHorizontalDirection: null, vaneVerticalDirection: null, temperatureIncrementOverride: null, inStandbyMode: null
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
                  if (mode === "off") payloadJson.power = false;
                  else {
                    if (!isPoweredOn(currentDeviceData) && payloadJson.power === null) payloadJson.power = true;
                    if (mode === "cool") payloadJson.operationMode = "Cool";
                    if (mode === "heat") payloadJson.operationMode = "Heat";
                    if (mode === "dry") payloadJson.operationMode = "Dry";
                    if (mode === "fan-only") payloadJson.operationMode = "Fan";
                    if (mode === "auto") payloadJson.operationMode = "Automatic";
                  }
                }
                if (exec.command === "action.devices.commands.SetFanSpeed") {
                  payloadJson.setFanSpeed = exec.params?.fanSpeed;
                  updatedStates.currentFanSpeedSetting = payloadJson.setFanSpeed;
                }
              }

              // Appel à la véritable API Mobile pour envoyer les ordres
              const execRes = await fetch(`${API_BASE}/ataunit/${encodeURIComponent(climId)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${melToken}`, "User-Agent": USER_AGENT },
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
      return html(`<h1>❌ Erreur Critique du Worker</h1><pre>${esc(error.stack || error.message)}</pre>`, 500);
    }
  }
};
