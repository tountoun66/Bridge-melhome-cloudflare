const MELCLOUD_API = "https://melcloudhome.com";
const TOKEN_URL = `${MELCLOUD_API}/oauth/token`;

async function getOAuth(env) {
  return await env.DB.prepare("SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1").first();
}

async function saveOAuth(env, tokens) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("INSERT INTO oauth_tokens(id,access_token,refresh_token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), tokens.access_token || null, tokens.refresh_token, tokens.expires_at || null, now, now).run();
}

async function refreshAccessToken(env, row) {
  if (!row?.refresh_token) throw new Error("Aucun refresh_token MELCloud enregistré");
  const clientId = env.MELCLOUD_CLIENT_ID;
  const clientSecret = env.MELCLOUD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Secrets MELCLOUD_CLIENT_ID / MELCLOUD_CLIENT_SECRET manquants");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: row.refresh_token, client_id: clientId, client_secret: clientSecret });
  const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!response.ok) throw new Error(`MELCloud OAuth refresh HTTP ${response.status}`);
  const data = await response.json();
  if (!data.refresh_token) data.refresh_token = row.refresh_token;
  data.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000;
  await saveOAuth(env, data);
  return data.access_token;
}

async function getAccessToken(env) {
  let row = await getOAuth(env);
  if (!row) throw new Error("Aucun compte MELCloud OAuth enregistré");
  if (row.access_token && row.expires_at && Number(row.expires_at) > Date.now() + 60000) return row.access_token;
  return await refreshAccessToken(env, row);
}

async function melcloudFetch(env, path, options = {}) {
  let token = await getAccessToken(env);
  let response = await fetch(`${MELCLOUD_API}${path}`, { ...options, headers: { Accept: "application/json, text/plain, */*", ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    const row = await getOAuth(env);
    token = await refreshAccessToken(env, row);
    response = await fetch(`${MELCLOUD_API}${path}`, { ...options, headers: { Accept: "application/json, text/plain, */*", ...(options.headers || {}), Authorization: `Bearer ${token}` } });
  }
  return response;
}

function getSetting(clim, keys) {
  for (const key of keys) if (clim?.[key] !== undefined && clim?.[key] !== null) return clim[key];
  for (const containerName of ["settings", "unitSettings"]) {
    const container = clim?.[containerName];
    if (!Array.isArray(container)) continue;
    for (const item of container) {
      const name = String(item?.name ?? item?.Name ?? "").toLowerCase();
      if (keys.some(k => k.toLowerCase() === name)) return item?.value ?? item?.Value ?? null;
    }
  }
  return null;
}
function isPoweredOn(clim) { const v = getSetting(clim, ["power", "Power"]); return v === true || String(v).toLowerCase() === "true"; }
function getRoomTemp(clim) { const n = Number.parseFloat(getSetting(clim, ["roomTemperature", "RoomTemperature", "indoorTemperature", "IndoorTemperature"])); return Number.isFinite(n) && n > 0 && n < 60 ? n : 20; }
function getTemp(clim) { const n = Number.parseFloat(getSetting(clim, ["setTemperature", "SetTemperature", "targetTemperature", "TargetTemperature", "defaultTemperature"])); return Number.isFinite(n) && n > 0 && n < 60 ? n : 20; }
function getGoogleMode(clim) { if (!isPoweredOn(clim)) return "off"; const mode = String(getSetting(clim, ["operationMode", "OperationMode"]) || "Automatic").toLowerCase(); if (mode.includes("cool")) return "cool"; if (mode.includes("heat")) return "heat"; if (mode.includes("dry")) return "dry"; if (mode.includes("fan")) return "fan-only"; return "auto"; }
function getGoogleFanSpeed(clim) { const value = getSetting(clim, ["setFanSpeed", "SetFanSpeed", "fanSpeed", "FanSpeed"]); if (value == null) return "Auto"; const str = String(value).toLowerCase(); if (str.includes("one") || str === "1") return "One"; if (str.includes("two") || str === "2") return "Two"; if (str.includes("three") || str === "3") return "Three"; if (str.includes("four") || str === "4") return "Four"; if (str.includes("five") || str === "5") return "Five"; return "Auto"; }
function googleDevices(clims) { return clims.map(clim => ({ id: String(clim.id ?? clim.ID), type: "action.devices.types.THERMOSTAT", traits: ["action.devices.traits.TemperatureSetting", "action.devices.traits.FanSpeed"], name: { name: clim.givenDisplayName ?? clim.GivenDisplayName ?? "Climatiseur" }, willReportState: false, attributes: { availableThermostatModes: "off,on,heat,cool,dry,fan-only,auto", thermostatTemperatureUnit: "C", supportsFanSpeedPercent: false, commandOnlyFanSpeed: false, availableFanSpeeds: { speeds: ["Auto", "One", "Two", "Three", "Four", "Five"].map((name, i) => ({ speed_name: name, speed_values: [{ lang: "fr", speed_synonym: [name, i === 0 ? "Automatique" : `Vitesse ${i}`] }, { lang: "en", speed_synonym: [name, i === 0 ? "Automatic" : `Speed ${i}`] }] })), ordered: true } } })); }

async function fulfillment(request, env) {
  const body = await request.json(); const requestId = body?.requestId; const intent = body?.inputs?.[0]?.intent;
  const context = await melcloudFetch(env, "/api/user/context");
  if (!context.ok) return Response.json({ error: `MELCloud context HTTP ${context.status}` }, { status: 502 });
  const data = await context.json(); const clims = data?.buildings?.[0]?.airToAirUnits || [];
  if (intent === "action.devices.SYNC") return Response.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices(clims) } });
  if (intent === "action.devices.QUERY") {
    const devices = {}; for (const clim of clims) { const id = String(clim.id ?? clim.ID); devices[id] = { online: true, status: "SUCCESS", thermostatMode: getGoogleMode(clim), thermostatTemperatureSetpoint: getTemp(clim), thermostatTemperatureAmbient: getRoomTemp(clim), currentFanSpeedSetting: getGoogleFanSpeed(clim) }; }
    return Response.json({ requestId, payload: { devices } });
  }
  if (intent === "action.devices.EXECUTE") {
    const results = []; const commands = body?.inputs?.[0]?.payload?.commands || [];
    for (const command of commands) for (const device of command.devices || []) {
      const clim = clims.find(c => String(c.id ?? c.ID) === String(device.id)); if (!clim) continue;
      const payload = { power: null, operationMode: null, setFanSpeed: null, setTemperature: null, vaneHorizontalDirection: null, vaneVerticalDirection: null, temperatureIncrementOverride: null, inStandbyMode: null };
      const states = { online: true, thermostatMode: getGoogleMode(clim), thermostatTemperatureSetpoint: getTemp(clim), currentFanSpeedSetting: getGoogleFanSpeed(clim) };
      for (const exec of command.execution || []) {
        if (exec.command === "action.devices.commands.OnOff") { payload.power = !!exec.params.on; states.thermostatMode = exec.params.on ? "auto" : "off"; }
        if (exec.command === "action.devices.commands.ThermostatTemperatureSetpoint") { payload.setTemperature = exec.params.thermostatTemperatureSetpoint; states.thermostatTemperatureSetpoint = exec.params.thermostatTemperatureSetpoint; }
        if (exec.command === "action.devices.commands.ThermostatSetMode") { const mode = exec.params.thermostatMode; states.thermostatMode = mode; if (mode === "off") payload.power = false; else { if (!isPoweredOn(clim) && payload.power === null) payload.power = true; payload.operationMode = ({ cool: "Cool", heat: "Heat", dry: "Dry", "fan-only": "Fan", auto: "Automatic" })[mode] ?? null; } }
        if (exec.command === "action.devices.commands.SetFanSpeed") { payload.setFanSpeed = exec.params.fanSpeed; states.currentFanSpeedSetting = exec.params.fanSpeed; }
      }
      const response = await melcloudFetch(env, `/api/ataunit/${device.id}`, { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
      results.push(response.ok ? { ids: [String(device.id)], status: "SUCCESS", states } : { ids: [String(device.id)], status: "ERROR", errorCode: "hardError" });
    }
    return Response.json({ requestId, payload: { commands: results } });
  }
  return Response.json({ requestId, payload: {} });
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/status") { const oauth = await getOAuth(env); return Response.json({ ok: true, oauthSession: !!oauth?.refresh_token, tokenExpiresAt: oauth?.expires_at ?? null }); }
    if (request.method === "POST" && url.pathname === "/api/save-oauth") { const body = await request.json(); if (!body?.refresh_token) return Response.json({ error: "refresh_token manquant" }, { status: 400 }); await saveOAuth(env, body); return Response.json({ success: true }); }
    if (request.method === "POST" && url.pathname === "/fulfillment") return fulfillment(request, env);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok", service: "melhome-bridge-cloudflare" });
    if (request.method === "GET" && url.pathname === "/") { const oauth = await getOAuth(env); return new Response(`MELHome Bridge Cloudflare — OAuth: ${oauth?.refresh_token ? "OK" : "NON CONFIGURE"}`); }
    return new Response("Not found", { status: 404 });
  } catch (error) { console.error("[MELHOME]", error); return Response.json({ error: error?.message || "Internal error" }, { status: 500 }); }
} };
