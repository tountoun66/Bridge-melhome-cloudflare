const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const pairCodes = {}; 

function extractXsrf(cookieStr) {
    const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/i);
    if (match) {
        try { return decodeURIComponent(match[1]); } catch(e) { return match[1]; }
    }
    return "1";
}

function getSetting(clim, keys) {
    for (let key of keys) {
        if (clim[key] !== undefined && clim[key] !== null) return clim[key];
    }
    const containers = [];
    if (Array.isArray(clim.settings)) containers.push(clim.settings);
    if (Array.isArray(clim.unitSettings)) containers.push(clim.unitSettings);
    
    for (let container of containers) {
        for (let item of container) {
            const itemName = String(item.name || item.Name || "").toLowerCase();
            if (keys.some(k => k.toLowerCase() === itemName)) {
                if (item.value !== undefined && item.value !== null) return item.value;
                if (item.Value !== undefined && item.Value !== null) return item.Value;
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
    const val = getSetting(clim, ["roomTemperature", "RoomTemperature", "indoorTemperature", "IndoorTemperature"]);
    const num = parseFloat(val);
    return (!isNaN(num) && num > 0 && num < 60) ? num : 20.0;
}

function getTemp(clim) {
    const val = getSetting(clim, ["setTemperature", "SetTemperature", "targetTemperature", "TargetTemperature", "defaultTemperature"]);
    const num = parseFloat(val);
    return (!isNaN(num) && num > 0 && num < 60) ? num : 20.0;
}

function getGoogleMode(clim) {
    if (!isPoweredOn(clim)) return "off"; 
    
    const val = getSetting(clim, ["operationMode", "OperationMode"]);
    const mode = String(val || "Automatic").toLowerCase();
    
    if (mode.includes("cool")) return "cool";
    if (mode.includes("heat")) return "heat";
    if (mode.includes("dry")) return "dry";
    if (mode.includes("fan")) return "fan-only";
    return "auto";
}

function getGoogleFanSpeed(clim) {
    const val = getSetting(clim, ["setFanSpeed", "SetFanSpeed", "fanSpeed", "FanSpeed"]);
    if (val === undefined || val === null) return "Auto";
    const str = String(val).toLowerCase();
    
    if (str.includes("one") || str === "1") return "One";
    if (str.includes("two") || str === "2") return "Two";
    if (str.includes("three") || str === "3") return "Three";
    if (str.includes("four") || str === "4") return "Four";
    if (str.includes("five") || str === "5") return "Five";
    return "Auto";
}

async function fetchMelcloudDevices(cookie) {
    const xsrf = extractXsrf(cookie);
    const safeCookie = cookie.trim().replace(/\n|\r/g, "");
    
    const response = await fetch("https://melcloudhome.com/api/user/context", {
        method: 'GET',
        headers: {
            "Cookie": safeCookie,
            "X-XSRF-TOKEN": xsrf,
            "X-Csrf": "1",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/plain, */*"
        }
    });
    
    if (!response.ok) throw new Error("Erreur de connexion API HTTP " + response.status);
    const data = await response.json();
    return (data.buildings && data.buildings.length > 0) ? (data.buildings[0].airToAirUnits || []) : [];
}

app.post('/api/save-cookie', (req, res) => {
    const { cookie } = req.body;
    if (!cookie) return res.status(400).json({ error: "Cookie manquant" });
    const pairCode = Math.floor(1000 + Math.random() * 9000).toString();
    pairCodes[pairCode] = cookie;
    pairCodes["master_cookie"] = cookie;
    res.json({ success: true, pairCode: pairCode });
});

app.get('/oauth/auth', (req, res) => {
    const { redirect_uri, state } = req.query;
    res.send(`
        <html>
            <head><title>Connexion Melhome</title></head>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2>Associer Melhome</h2>
                <form method="POST" action="/oauth/login">
                    <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}" />
                    <input type="hidden" name="state" value="${state || ''}" />
                    <input type="text" name="pairCode" placeholder="Code" maxlength="4" style="padding: 10px; width: 200px; font-size: 24px; text-align: center; letter-spacing: 5px;" required />
                    <br><br><button type="submit" style="padding: 12px 24px; background: #2196F3; color: white; border: none; cursor: pointer; border-radius: 5px;">Valider</button>
                </form>
            </body>
        </html>
    `);
});

app.post('/oauth/login', (req, res) => {
    const { pairCode, redirect_uri, state } = req.body;
    let userCookie = pairCodes[pairCode] || pairCodes["master_cookie"];
    
    if (!userCookie) return res.send("Erreur : Code invalide.");

    const authCode = "auth_" + Math.random().toString(36).substr(2, 9);
    pairCodes[authCode] = userCookie; 
    
    const separator = redirect_uri.includes('?') ? '&' : '?';
    res.redirect(`${redirect_uri}${separator}code=${authCode}&state=${state || ''}`);
});

app.all('/oauth/token', (req, res) => {
    const code = req.body.code || req.query.code;
    let userCookie = pairCodes[code] || pairCodes["master_cookie"];
    
    if (!userCookie) return res.status(400).json({ error: "invalid_grant" });

    const accessToken = Buffer.from(userCookie).toString('base64');
    res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 31536000 });
});

app.post('/fulfillment', async (req, res) => {
    const body = req.body;
    const requestId = body?.requestId;
    const intent = body?.inputs?.[0]?.intent;
    const authHeader = req.headers.authorization;

    if (!authHeader) return res.status(401).send("Non autorisé");
    
    let userCookie = "";
    try {
        userCookie = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf-8');
    } catch(e) {
        userCookie = pairCodes["master_cookie"] || "";
    }

    if (!userCookie) return res.status(401).send("Jeton invalide");

    try {
        if (intent === 'action.devices.SYNC') {
            const clims = await fetchMelcloudDevices(userCookie);
            const googleDevices = clims.map(clim => ({
                id: (clim.id || clim.ID).toString(),
                type: "action.devices.types.THERMOSTAT",
                traits: [
                    "action.devices.traits.TemperatureSetting",
                    "action.devices.traits.FanSpeed"
                ],
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
                            { speed_name: "One", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 1", "1", "Un"] }, { lang: "en", speed_synonym: ["Speed 1", "1", "One"] }] },
                            { speed_name: "Two", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 2", "2", "Deux"] }, { lang: "en", speed_synonym: ["Speed 2", "2", "Two"] }] },
                            { speed_name: "Three", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 3", "3", "Trois"] }, { lang: "en", speed_synonym: ["Speed 3", "3", "Three"] }] },
                            { speed_name: "Four", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 4", "4", "Quatre"] }, { lang: "en", speed_synonym: ["Speed 4", "4", "Four"] }] },
                            { speed_name: "Five", speed_values: [{ lang: "fr", speed_synonym: ["Vitesse 5", "5", "Cinq"] }, { lang: "en", speed_synonym: ["Speed 5", "5", "Five"] }] }
                        ],
                        ordered: true
                    }
                }
            }));
            return res.json({ requestId, payload: { agentUserId: "melhome_user", devices: googleDevices } });
        }

        if (intent === 'action.devices.QUERY') {
            const clims = await fetchMelcloudDevices(userCookie);
            const devicesState = {};

            clims.forEach(clim => {
                const id = (clim.id || clim.ID).toString();
                devicesState[id] = {
                    online: true,
                    status: "SUCCESS",
                    thermostatMode: getGoogleMode(clim),
                    thermostatTemperatureSetpoint: getTemp(clim),
                    thermostatTemperatureAmbient: getRoomTemp(clim),
                    currentFanSpeedSetting: getGoogleFanSpeed(clim)
                };
            });
            
            return res.json({ requestId, payload: { devices: devicesState } });
        }

        if (intent === 'action.devices.EXECUTE') {
            const commands = body.inputs[0].payload.commands;
            const clims = await fetchMelcloudDevices(userCookie);
            const xsrf = extractXsrf(userCookie);
            const safeCookie = userCookie.trim().replace(/\n|\r/g, "");
            
            const responseCommands = [];

            for (let command of commands) {
                for (let device of command.devices) {
                    const climId = device.id;
                    const currentDeviceData = clims.find(c => (c.id || c.ID).toString() === climId);
                    if (!currentDeviceData) continue;

                    // LE PAQUET PARFAIT : Basé sur votre capture d'écran exacte
                    let payloadJson = {
                        power: null,
                        operationMode: null,
                        setFanSpeed: null,
                        setTemperature: null,
                        vaneHorizontalDirection: null,
                        vaneVerticalDirection: null,
                        temperatureIncrementOverride: null,
                        inStandbyMode: null
                    };

                    let updatedStates = {
                        online: true,
                        thermostatMode: getGoogleMode(currentDeviceData),
                        thermostatTemperatureSetpoint: getTemp(currentDeviceData),
                        currentFanSpeedSetting: getGoogleFanSpeed(currentDeviceData)
                    };
                    
                    command.execution.forEach(exec => {
                        if (exec.command === 'action.devices.commands.OnOff') {
                            payloadJson.power = exec.params.on;
                            updatedStates.thermostatMode = exec.params.on ? "auto" : "off";
                        }
                        if (exec.command === 'action.devices.commands.ThermostatTemperatureSetpoint') {
                            payloadJson.setTemperature = exec.params.thermostatTemperatureSetpoint;
                            updatedStates.thermostatTemperatureSetpoint = exec.params.thermostatTemperatureSetpoint;
                        }
                        if (exec.command === 'action.devices.commands.ThermostatSetMode') {
                            const mode = exec.params.thermostatMode;
                            updatedStates.thermostatMode = mode;
                            if (mode === "off") {
                                payloadJson.power = false;
                            } else {
                                if (!isPoweredOn(currentDeviceData) && payloadJson.power === null) payloadJson.power = true;
                                if (mode === "cool") payloadJson.operationMode = "Cool";
                                if (mode === "heat") payloadJson.operationMode = "Heat";
                                if (mode === "dry") payloadJson.operationMode = "Dry";
                                if (mode === "fan-only") payloadJson.operationMode = "Fan";
                                if (mode === "auto") payloadJson.operationMode = "Automatic";
                            }
                        }
                        // LA CORRECTION : "SetFanSpeed" (au lieu de FanSpeed)
                        if (exec.command === 'action.devices.commands.SetFanSpeed') {
                            const targetSpeed = exec.params.fanSpeed; // "One", "Two", "Auto"...
                            payloadJson.setFanSpeed = targetSpeed;
                            updatedStates.currentFanSpeedSetting = targetSpeed;
                        }
                    });

                    await fetch(`https://melcloudhome.com/api/ataunit/${climId}`, {
                        method: 'PUT',
                        headers: {
                            "Content-Type": "application/json; charset=utf-8",
                            "Cookie": safeCookie,
                            "X-XSRF-TOKEN": xsrf,
                            "X-Csrf": "1",
                            "X-Requested-With": "XMLHttpRequest",
                            "Accept": "application/json, text/plain, */*"
                        },
                        body: JSON.stringify(payloadJson)
                    });

                    responseCommands.push({
                        ids: [climId],
                        status: "SUCCESS",
                        states: updatedStates
                    });
                }
            }
            return res.json({ requestId, payload: { commands: responseCommands } });
        }
    } catch (error) {
        console.error("Erreur d'exécution :", error);
        return res.json({ requestId, payload: { errorCode: "hardError" } });
    }
});

app.listen(PORT, () => console.log(`Serveur Bridge en ligne sur le port ${PORT}`));
