const MELCLOUD_API = "https://melcloudhome.com";

function extractXsrf(cookieStr) {
  const match = String(cookieStr || "").match(/XSRF-TOKEN=([^;]+)/i);
  if (!match) return "1";
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function getSetting(clim, keys) {
  for (const key of keys) {
    if (clim?.[key] !== undefined && clim?.[key] !== null) return clim[key];
  }
  for (const containerName of ["settings", "unitSettings"]) {
    const container = clim?.[containerName];
    if (!Array.isArray(container)) continue;
    for (const item of container) {
      const name = String(item?.name ?? item?.Name ?? "").toLowerCase();
      if (keys.some(k => k.toLowerCase() === name)) {
        if (item?.value !== undefined && item?.value !== null) return item.value;
        if (item?.Value !== undefined && item?.Value !== null) return item.Value;
      }
    }
  }
  return null;
}

function isPoweredOn(clim) {
  const val = getSetting(clim, ["power", "Power"]);
  return val === true || String(val).toLowerCase() === "true";
}

function getRoomTemp(clim) {
  const n = Number.parseFloat(getSetting(clim, ["roomTemperature", "RoomTemperature", "indoorTemperature", "IndoorTemperature"]));
  return Number.isFinite(n) && n > 0 && n < 60 ? n : 20;
}

function getTemp(clim) {
  const n = Number.parseFloat(getSetting(clim, ["setTemperature", "SetTemperature", "targetTemperature", "TargetTemperature", "defaultTemperature"]));
  return Number.isFinite(n) && n > 0 && n < 60 ? n : 20;
}

function getGoogleMode(clim) {
  if (!isPoweredOn(clim)) return "off";
  const mode = String(getSetting(clim, ["operationMode", "OperationMode"]) || "Automatic").toLowerCase();
  if (mode.includes("cool")) return "cool";
  if (mode.includes("heat")) return "heat";
  if (mode.includes("dry")) return "dry";
  if (mode.includes("fan")) return "fan-only";
  return "auto";
}

function getGoogleFanSpeed(clim) {
  const value = getSetting(clim, ["setFanSpeed", "SetFanSpeed", "fanSpeed", "FanSpeed"]);
  if (value == null) return "Auto";
  const str = String(value).toLowerCase();
  if (str.includes("one") || str === "1") return "One";
  if (str.includes("two") || str === "2") return "Two";
  if (str.includes("three") || str === "3") return "Three";
  if (str.includes("four") || str === "4") return "Four";
  if (str.includes("five") || str === "5") return "Five";
  return "Auto";
}

function html(body, status = 200) {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MELHome Bridge</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:32px;background:#f5f7fa;color:#17202a}.card{background:white;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 2px 12px #0001}h1{margin-top:0}.ok{color:#087f5b}.muted{color:#68737d}code{background:#eef1f4;padding:2px 5px;border-radius:5px}</style></head><body>${body}</body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function getSession(env) {
  const row = await env.DB.prepare("SELECT id,cookie,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 1").first();
  return row || null;
}

async function saveSession(env, cookie) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("INSERT INTO sessions(id,cookie,created_at,updated_at) VALUES(?,?,?,?)").bind(id, cookie, now, now).run();
  return id;
}

async function fetchMelcloudDevices(cookie) {
  const xsrf = extractXsrf(cookie);
  const safeCookie = String(cookie).trim().replace(/[\r\n]/g, "");
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${MELCLOUD_API}/api/user/context`, {
        headers: {
          Cookie: safeCookie,
          "X-XSRF-TOKEN": xsrf,
          "X-Csrf": "1",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/plain, */*"
        }
      });
      if (response.ok) {
        const data = await response.json();
        return data?.buildings?.[0]?.airToAirUnits || [];
      }
      if (response.status !== 500 || attempt === 2) throw new Error(`MELCloud HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  return [];
}

function googleDevices(clims) {
  return clims.map(clim => ({
    id: String(clim.id ?? clim.ID),
    type: "action.devices.types.THERMOSTAT",
    traits: ["action.devices.traits.TemperatureSetting", "action.devices.traits.FanSpeed"],
    name: { name: clim.givenDisplayName ?? clim.GivenDisplayName ?? "Climatiseur" },
    willReportState: false,
    attributes: {
      availableThermostatModes: "off,on,heat,cool,dry,fan-only,auto",
      thermostatTemperatureUnit: "C",
      supportsFanSpeedPercent: false,
      commandOnlyFanSpeed: false,
      availableFanSpeeds: {
        speeds: ["Auto", "One", "Two", "Three", "Four", "Five"].map((name, i) => ({ speed_name: name, speed_values: [{ lang: "fr", speed_synonym: [name, i === 0 ? "Automatique" : `Vitesse ${i}`] }, { lang: "en", speed_synonym: [name, i === 0 ? "Automatic" : `Speed ${i}`] }] })),
        ordered: true
      }
    }
  }));
}

async function fulfillment(request, env) {
  const body = await request.json();
  const requestId = body?.requestId;
  const intent = body?.inputs?.[0]?.intent;
  const session = await getSession(env);
  if (!session?.cookie) return Response.json({ error: "Aucune session MELCloud disponible" }, { status: 401 });
  const cookie = session.cookie;
  const clims = await fetchMelcloudDevices(cookie);

  if (intent === "action.devices.SYNC") {
    return Response.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices(clims) } });
  }

  if (intent === "action.devices.QUERY") {
    const devices = {};
    for (const clim of clims) {
      const id = String(clim.id ?? clim.ID);
      devices[id] = { online: true, status: "SUCCESS", thermostatMode: getGoogleMode(clim), thermostatTemperatureSetpoint: getTemp(clim), thermostatTemperatureAmbient: getRoomTemp(clim), currentFanSpeedSetting: getGoogleFanSpeed(clim) };
    }
    return Response.json({ requestId, payload: { devices } });
  }

  if (intent === "action.devices.EXECUTE") {
    const commands = body?.inputs?.[0]?.payload?.commands || [];
    const xsrf = extractXsrf(cookie);
    const safeCookie = String(cookie).trim().replace(/[\r\n]/g, "");
    const results = [];
    for (const command of commands) {
      for (const device of command.devices || []) {
        const clim = clims.find(c => String(c.id ?? c.ID) === String(device.id));
        if (!clim) continue;
        const payload = { power: null, operationMode: null, setFanSpeed: null, setTemperature: null, vaneHorizontalDirection: null, vaneVerticalDirection: null, temperatureIncrementOverride: null, inStandbyMode: null };
        const states = { online: true, thermostatMode: getGoogleMode(clim), thermostatTemperatureSetpoint: getTemp(clim), currentFanSpeedSetting: getGoogleFanSpeed(clim) };
        for (const exec of command.execution || []) {
          if (exec.command === "action.devices.commands.OnOff") { payload.power = !!exec.params.on; states.thermostatMode = exec.params.on ? "auto" : "off"; }
          if (exec.command === "action.devices.commands.ThermostatTemperatureSetpoint") { payload.setTemperature = exec.params.thermostatTemperatureSetpoint; states.thermostatTemperatureSetpoint = exec.params.thermostatTemperatureSetpoint; }
          if (exec.command === "action.devices.commands.ThermostatSetMode") {
            const mode = exec.params.thermostatMode; states.thermostatMode = mode;
            if (mode === "off") payload.power = false;
            else { if (!isPoweredOn(clim) && payload.power === null) payload.power = true; payload.operationMode = ({ cool: "Cool", heat: "Heat", dry: "Dry", "fan-only": "Fan", auto: "Automatic" })[mode] ?? null; }
          }
          if (exec.command === "action.devices.commands.SetFanSpeed") { payload.setFanSpeed = exec.params.fanSpeed; states.currentFanSpeedSetting = exec.params.fanSpeed; }
        }
        let ok = false;
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            const response = await fetch(`${MELCLOUD_API}/api/ataunit/${device.id}`, { method: "PUT", headers: { "Content-Type": "application/json; charset=utf-8", Cookie: safeCookie, "X-XSRF-TOKEN": xsrf, "X-Csrf": "1", "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/plain, */*" }, body: JSON.stringify(payload) });
            if (response.ok) { ok = true; break; }
            if (response.status !== 500 || attempt === 2) break;
          } catch {}
          await new Promise(r => setTimeout(r, 800));
        }
        results.push(ok ? { ids: [String(device.id)], status: "SUCCESS", states } : { ids: [String(device.id)], status: "ERROR", errorCode: "hardError" });
      }
    }
    return Response.json({ requestId, payload: { commands: results } });
  }
  return Response.json({ requestId, payload: {} });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        const session = await getSession(env);
        return html(`<div class="card"><h1>❄️ MELHome Bridge</h1><p class="ok">● Cloudflare Worker opérationnel</p><p class="muted">Version self-hosted — chaque utilisateur possède sa propre instance.</p></div><div class="card"><h2>MELCloud</h2><p>${session ? "🟢 Session enregistrée" : "🔴 Aucune session enregistrée"}</p><p class="muted">La prochaine étape est la connexion OAuth MELCloud. L'ancien endpoint de pairage reste disponible pour les tests.</p></div>`);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const session = await getSession(env);
        return Response.json({ ok: true, melcloudSession: !!session, updatedAt: session?.updated_at ?? null });
      }
      if (request.method === "POST" && url.pathname === "/api/save-cookie") {
        const body = await request.json();
        if (!body?.cookie) return Response.json({ error: "Cookie manquant" }, { status: 400 });
        const id = await saveSession(env, body.cookie);
        return Response.json({ success: true, sessionId: id });
      }
      if (request.method === "POST" && url.pathname === "/fulfillment") return fulfillment(request, env);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok", service: "melhome-bridge-cloudflare" });
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("[MELHOME]", error);
      return Response.json({ error: error?.message || "Internal error" }, { status: 500 });
    }
  }
};
