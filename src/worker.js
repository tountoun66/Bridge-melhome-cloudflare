const AUTH_BASE = "https://auth.melcloudhome.com";
const TOKEN_URL = `${AUTH_BASE}/connect/token`;

const API_BASE = "https://mobile.bff.melcloudhome.com";

const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES =
  "openid profile email offline_access IdentityServerApi";

const AUTH_BASIC = "Basic aG9tZW1vYmlsZTo=";

const USER_AGENT =
  "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";


// ============================================================
// D1
// ============================================================

async function getOAuth(env) {
  return env.DB
    .prepare(
      "SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1"
    )
    .first();
}


async function saveOAuth(env, tokens) {
  if (!tokens?.refresh_token) {
    throw new Error(
      "MELCloud n'a pas fourni de refresh_token"
    );
  }

  const now = Date.now();

  const expiresAt =
    tokens.expires_at ||
    now +
      Number(tokens.expires_in || 3600) *
        1000;

  await env.DB
    .prepare(
      "DELETE FROM oauth_tokens"
    )
    .run();

  await env.DB
    .prepare(
      `INSERT INTO oauth_tokens
      (
        id,
        access_token,
        refresh_token,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      tokens.access_token || null,
      tokens.refresh_token,
      expiresAt,
      now,
      now
    )
    .run();
}


// ============================================================
// TOKEN
// ============================================================

async function refreshToken(env, row) {
  if (!row?.refresh_token) {
    throw new Error(
      "Aucun refresh_token MELCloud enregistré"
    );
  }

  const body =
    new URLSearchParams({
      grant_type:
        "refresh_token",

      client_id:
        CLIENT_ID,

      refresh_token:
        row.refresh_token,
    });


  const response =
    await fetch(TOKEN_URL, {
      method: "POST",

      headers: {
        Authorization:
          AUTH_BASIC,

        "Content-Type":
          "application/x-www-form-urlencoded",

        Accept:
          "application/json",

        "User-Agent":
          USER_AGENT,
      },

      body:
        body.toString(),
    });


  if (!response.ok) {
    const detail =
      await response.text();

    throw new Error(
      `MELCloud OAuth refresh HTTP ${response.status}: ${detail.slice(
        0,
        500
      )}`
    );
  }


  const tokens =
    await response.json();


  // Certains serveurs ne renvoient
  // pas le refresh_token à chaque refresh.
  if (!tokens.refresh_token) {
    tokens.refresh_token =
      row.refresh_token;
  }


  await saveOAuth(
    env,
    tokens
  );


  return tokens.access_token;
}


async function getAccessToken(env) {
  const row =
    await getOAuth(env);


  if (!row) {
    throw new Error(
      "Aucun compte MELCloud OAuth enregistré"
    );
  }


  // 5 minutes de marge
  if (
    row.access_token &&
    Number(row.expires_at) >
      Date.now() + 300000
  ) {
    return row.access_token;
  }


  return refreshToken(
    env,
    row
  );
}


// ============================================================
// MELCLOUD API
// ============================================================

async function mel(
  env,
  path,
  options = {}
) {
  let accessToken =
    await getAccessToken(env);


  const makeRequest =
    async token => {
      return fetch(
        `${API_BASE}/${path.replace(
          /^\//,
          ""
        )}`,
        {
          ...options,

          headers: {
            Accept:
              "application/json, text/plain, */*",

            "User-Agent":
              USER_AGENT,

            ...(options.headers || {}),

            Authorization:
              `Bearer ${token}`,
          },
        }
      );
    };


  let response =
    await makeRequest(
      accessToken
    );


  // Token expiré/refusé
  if (
    response.status === 401
  ) {
    const row =
      await getOAuth(env);


    accessToken =
      await refreshToken(
        env,
        row
      );


    response =
      await makeRequest(
        accessToken
      );
  }


  return response;
}


// ============================================================
// OAUTH — UTILITAIRE POUR ANDROID
// ============================================================
//
// Android doit utiliser ces informations pour lancer
// l'authentification MELCloud.
//
// Le redirect URI DOIT rester :
//     melcloudhome://
//
// Le Worker ne reçoit donc pas le callback OAuth.
//
// ============================================================

async function createPAR() {
  const random =
    crypto.getRandomValues(
      new Uint8Array(32)
    );


  let binary = "";

  for (const byte of random) {
    binary += String.fromCharCode(
      byte
    );
  }


  const verifier =
    btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");


  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        verifier
      )
    );


  let digestBinary = "";

  for (
    const byte of
      new Uint8Array(digest)
  ) {
    digestBinary += String.fromCharCode(
      byte
    );
  }


  const challenge =
    btoa(digestBinary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");


  const stateBytes =
    crypto.getRandomValues(
      new Uint8Array(16)
    );


  let stateBinary = "";

  for (const byte of stateBytes) {
    stateBinary += String.fromCharCode(
      byte
    );
  }


  const state =
    btoa(stateBinary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");


  const body =
    new URLSearchParams({
      response_type:
        "code",

      state,

      code_challenge:
        challenge,

      code_challenge_method:
        "S256",

      client_id:
        CLIENT_ID,

      scope:
        SCOPES,

      redirect_uri:
        REDIRECT_URI,
    });


  const response =
    await fetch(
      `${AUTH_BASE}/connect/par`,
      {
        method: "POST",

        headers: {
          Authorization:
            AUTH_BASIC,

          "Content-Type":
            "application/x-www-form-urlencoded",

          Accept:
            "application/json",

          "User-Agent":
            USER_AGENT,
        },

        body:
          body.toString(),
      }
    );


  if (!response.ok) {
    const detail =
      await response.text();

    throw new Error(
      `MELCloud PAR HTTP ${response.status}: ${detail.slice(
        0,
        500
      )}`
    );
  }


  const result =
    await response.json();


  if (!result.request_uri) {
    throw new Error(
      "MELCloud n'a pas fourni de request_uri"
    );
  }


  return {
    request_uri:
      result.request_uri,

    verifier,

    state,
  };
}


// ============================================================
// PAGE
// ============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    );
}


function page(
  body,
  status = 200
) {
  return new Response(
    `<!doctype html>
<html lang="fr">

<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<title>MELHome Bridge</title>
</head>

<body style="
font-family:system-ui;
max-width:700px;
margin:40px auto;
padding:20px;
">

${body}

</body>
</html>`,

    {
      status,

      headers: {
        "content-type":
          "text/html;charset=utf-8",

        "cache-control":
          "no-store",
      },
    }
  );
}


// ============================================================
// GOOGLE HOME DEVICES
// ============================================================

function setting(c, keys) {
  for (const key of keys) {
    if (c?.[key] != null) {
      return c[key];
    }
  }


  for (
    const name of [
      "settings",
      "unitSettings",
    ]
  ) {
    const list =
      Array.isArray(c?.[name])
        ? c[name]
        : [];


    for (const item of list) {
      const itemName =
        String(
          item?.name ??
          item?.Name ??
          ""
        ).toLowerCase();


      if (
        keys.some(
          key =>
            key.toLowerCase() ===
            itemName
        )
      ) {
        return (
          item?.value ??
          item?.Value ??
          null
        );
      }
    }
  }


  return null;
}


function isOn(c) {
  const value =
    setting(c, [
      "power",
      "Power",
    ]);


  return (
    value === true ||
    String(value).toLowerCase() ===
      "true"
  );
}


function roomTemperature(c) {
  const value =
    Number.parseFloat(
      setting(c, [
        "roomTemperature",
        "RoomTemperature",
        "indoorTemperature",
        "IndoorTemperature",
      ])
    );


  return Number.isFinite(value) &&
    value > 0 &&
    value < 60
    ? value
    : 20;
}


function setTemperature(c) {
  const value =
    Number.parseFloat(
      setting(c, [
        "setTemperature",
        "SetTemperature",
        "targetTemperature",
        "TargetTemperature",
        "defaultTemperature",
      ])
    );


  return Number.isFinite(value) &&
    value > 0 &&
    value < 60
    ? value
    : 20;
}


function operationMode(c) {
  if (!isOn(c)) {
    return "off";
  }


  const value =
    String(
      setting(c, [
        "operationMode",
        "OperationMode",
      ]) ||
        "Automatic"
    ).toLowerCase();


  if (
    value.includes("cool")
  ) {
    return "cool";
  }


  if (
    value.includes("heat")
  ) {
    return "heat";
  }


  if (
    value.includes("dry")
  ) {
    return "dry";
  }


  if (
    value.includes("fan")
  ) {
    return "fan-only";
  }


  return "auto";
}


function fanSpeed(c) {
  const value =
    String(
      setting(c, [
        "setFanSpeed",
        "SetFanSpeed",
        "fanSpeed",
        "FanSpeed",
      ]) ?? ""
    ).toLowerCase();


  if (
    value.includes("one") ||
    value === "1"
  ) {
    return "One";
  }


  if (
    value.includes("two") ||
    value === "2"
  ) {
    return "Two";
  }


  if (
    value.includes("three") ||
    value === "3"
  ) {
    return "Three";
  }


  if (
    value.includes("four") ||
    value === "4"
  ) {
    return "Four";
  }


  if (
    value.includes("five") ||
    value === "5"
  ) {
    return "Five";
  }


  return "Auto";
}


function devices(cs) {
  return cs.map(
    c => ({
      id: String(
        c.id ?? c.ID
      ),

      type:
        "action.devices.types.THERMOSTAT",

      traits: [
        "action.devices.traits.TemperatureSetting",
        "action.devices.traits.FanSpeed",
      ],

      name: {
        name:
          c.givenDisplayName ??
          c.GivenDisplayName ??
          "Climatiseur",
      },

      willReportState:
        false,

      attributes: {
        availableThermostatModes:
          "off,on,heat,cool,dry,fan-only,auto",

        thermostatTemperatureUnit:
          "C",

        supportsFanSpeedPercent:
          false,

        commandOnlyFanSpeed:
          false,

        availableFanSpeeds: {
          speeds: [
            "Auto",
            "One",
            "Two",
            "Three",
            "Four",
            "Five",
          ].map(
            (name, index) => ({
              speed_name:
                name,

              speed_values: [
                {
                  lang:
                    "fr",

                  speed_synonym: [
                    name,

                    index
                      ? `Vitesse ${index}`
                      : "Automatique",
                  ],
                },

                {
                  lang:
                    "en",

                  speed_synonym: [
                    name,

                    index
                      ? `Speed ${index}`
                      : "Automatic",
                  ],
                },
              ],
            })
          ),

          ordered: true,
        },
      },
    })
  );
}


// ============================================================
// GOOGLE HOME FULFILLMENT
// ============================================================

async function fulfillment(
  request,
  env
) {
  const body =
    await request.json();


  const requestId =
    body?.requestId;

  const intent =
    body?.inputs?.[0]?.intent;


  if (
    !request.headers.get(
      "authorization"
    )
  ) {
    return new Response(
      "Non autorisé",
      {
        status: 401,
      }
    );
  }


  const response =
    await mel(
      env,
      "context"
    );


  if (!response.ok) {
    return Response.json(
      {
        error:
          `MELCloud context HTTP ${response.status}`,
      },
      {
        status: 502,
      }
    );
  }


  const context =
    await response.json();


  const units =
    context
      ?.buildings?.[0]
      ?.airToAirUnits || [];


  // ----------------------------------------------------------
  // SYNC
  // ----------------------------------------------------------

  if (
    intent ===
    "action.devices.SYNC"
  ) {
    return Response.json({
      requestId,

      payload: {
        agentUserId:
          "melhome_user",

        devices:
          devices(units),
      },
    });
  }


  // ----------------------------------------------------------
  // QUERY
  // ----------------------------------------------------------

  if (
    intent ===
    "action.devices.QUERY"
  ) {
    const result = {};


    for (const unit of units) {
      const id =
        String(
          unit.id ??
          unit.ID
        );


      result[id] = {
        online: true,

        status:
          "SUCCESS",

        thermostatMode:
          operationMode(unit),

        thermostatTemperatureSetpoint:
          setTemperature(unit),

        thermostatTemperatureAmbient:
          roomTemperature(unit),

        currentFanSpeedSetting:
          fanSpeed(unit),
      };
    }


    return Response.json({
      requestId,

      payload: {
        devices:
          result,
      },
    });
  }


  // ----------------------------------------------------------
  // EXECUTE
  // ----------------------------------------------------------

  if (
    intent ===
    "action.devices.EXECUTE"
  ) {
    const commands = [];


    for (
      const command of
        body?.inputs?.[0]
          ?.payload
          ?.commands || []
    ) {
      for (
        const device of
          command.devices || []
      ) {
        const unit =
          units.find(
            x =>
              String(
                x.id ??
                x.ID
              ) ===
              String(
                device.id
              )
          );


        if (!unit) {
          continue;
        }


        const params = {
          power: null,

          operationMode:
            null,

          setFanSpeed:
            null,

          setTemperature:
            null,

          vaneHorizontalDirection:
            null,

          vaneVerticalDirection:
            null,

          temperatureIncrementOverride:
            null,

          inStandbyMode:
            null,
        };


        const states = {
          online: true,

          thermostatMode:
            operationMode(unit),

          thermostatTemperatureSetpoint:
            setTemperature(unit),

          currentFanSpeedSetting:
            fanSpeed(unit),
        };


        for (
          const execution of
            command.execution ||
            []
        ) {

          // ON / OFF
          if (
            execution.command ===
            "action.devices.commands.OnOff"
          ) {
            params.power =
              !!execution.params.on;


            states.thermostatMode =
              execution.params.on
                ? "auto"
                : "off";
          }


          // TEMPÉRATURE
          if (
            execution.command ===
            "action.devices.commands.ThermostatTemperatureSetpoint"
          ) {
            params.setTemperature =
              execution.params
                .thermostatTemperatureSetpoint;


            states.thermostatTemperatureSetpoint =
              execution.params
                .thermostatTemperatureSetpoint;
          }


          // MODE
          if (
            execution.command ===
            "action.devices.commands.ThermostatSetMode"
          ) {
            const mode =
              execution.params
                .thermostatMode;


            states.thermostatMode =
              mode;


            if (
              mode === "off"
            ) {
              params.power =
                false;
            } else {

              if (
                !isOn(unit) &&
                params.power ===
                  null
              ) {
                params.power =
                  true;
              }


              params.operationMode =
                {
                  cool:
                    "Cool",

                  heat:
                    "Heat",

                  dry:
                    "Dry",

                  "fan-only":
                    "Fan",

                  auto:
                    "Automatic",
                }[mode] ??
                null;
            }
          }


          // VENTILATION
          if (
            execution.command ===
            "action.devices.commands.SetFanSpeed"
          ) {
            params.setFanSpeed =
              execution.params
                .fanSpeed;


            states.currentFanSpeedSetting =
              execution.params
                .fanSpeed;
          }
        }


        const result =
          await mel(
            env,
            `monitor/ataunit/${encodeURIComponent(
              device.id
            )}`,
            {
              method:
                "PUT",

              headers: {
                "Content-Type":
                  "application/json; charset=utf-8",
              },

              body:
                JSON.stringify(
                  params
                ),
            }
          );


        if (result.ok) {
          commands.push({
            ids: [
              String(
                device.id
              ),
            ],

            status:
              "SUCCESS",

            states,
          });
        } else {
          commands.push({
            ids: [
              String(
                device.id
              ),
            ],

            status:
              "ERROR",

            errorCode:
              "hardError",
          });
        }
      }
    }


    return Response.json({
      requestId,

      payload: {
        commands,
      },
    });
  }


  return Response.json({
    requestId,

    payload: {},
  });
}


// ============================================================
// WORKER
// ============================================================

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(request.url);


    try {

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname ===
          "/api/status"
      ) {
        const oauth =
          await getOAuth(env);


        return Response.json({
          ok: true,

          oauthSession:
            !!oauth?.refresh_token,

          tokenExpiresAt:
            oauth?.expires_at ??
            null,
        });
      }


      // ------------------------------------------------------
      // SETUP
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname ===
          "/setup"
      ) {
        const oauth =
          await getOAuth(env);


        return page(`
          <h1>
            ❄️ MELHome Bridge
          </h1>

          <p>
            Cloudflare fonctionne correctement.
          </p>

          <p>
            OAuth MELCloud :
            <b>
              ${
                oauth?.refresh_token
                  ? "CONFIGURE"
                  : "NON CONFIGURE"
              }
            </b>
          </p>

          <hr>

          <h2>
            Connexion MELCloud
          </h2>

          <p>
            La connexion MELCloud doit être
            effectuée depuis l'application
            Android avec la page officielle
            MELCloud.
          </p>

          <p>
            Le Worker n'enregistre jamais
            ton mot de passe MELCloud.
          </p>

          <p>
            Une fois le refresh token transmis
            par l'application Android, il sera
            enregistré automatiquement dans D1.
          </p>
        `);
      }


      // ------------------------------------------------------
      // OAUTH INFO POUR ANDROID
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname ===
          "/api/oauth/start"
      ) {
        const data =
          await createPAR();


        return Response.json({
          ok: true,

          client_id:
            CLIENT_ID,

          redirect_uri:
            REDIRECT_URI,

          scope:
            SCOPES,

          request_uri:
            data.request_uri,

          code_verifier:
            data.verifier,

          state:
            data.state,

          authorize_url:
            `${AUTH_BASE}/connect/authorize?client_id=${encodeURIComponent(
              CLIENT_ID
            )}&request_uri=${encodeURIComponent(
              data.request_uri
            )}`,
        });
      }


      // ------------------------------------------------------
      // SAUVEGARDE DU REFRESH TOKEN ANDROID
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname ===
          "/api/save-oauth"
      ) {
        const data =
          await request.json();


        if (
          !data?.refresh_token
        ) {
          return Response.json(
            {
              ok: false,

              error:
                "refresh_token manquant",
            },
            {
              status: 400,
            }
          );
        }


        await saveOAuth(
          env,
          data
        );


        return Response.json({
          ok: true,

          saved: true,
        });
      }


      // ------------------------------------------------------
      // GOOGLE HOME
      // ------------------------------------------------------

      if (
        request.method === "POST" &&
        url.pathname ===
          "/fulfillment"
      ) {
        return fulfillment(
          request,
          env
        );
      }


      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname ===
          "/health"
      ) {
        return Response.json({
          status:
            "ok",

          service:
            "melhome-bridge-cloudflare",
        });
      }


      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        const oauth =
          await getOAuth(env);


        return page(`
          <h1>
            ❄️ MELHome Bridge
          </h1>

          <p>
            Cloudflare opérationnel.
          </p>

          <p>
            OAuth MELCloud :
            <b>
              ${
                oauth?.refresh_token
                  ? "CONFIGURE"
                  : "NON CONFIGURE"
              }
            </b>
          </p>

          <p>
            <a href="/setup">
              Configuration
            </a>
          </p>

          <p>
            <a href="/api/status">
              Vérifier le statut
            </a>
          </p>

          <p>
            <a href="/api/oauth/start">
              Tester le PAR OAuth
            </a>
          </p>
        `);
      }


      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      return new Response(
        "Not found",
        {
          status: 404,
        }
      );

    } catch (error) {

      console.error(
        "[MELHOME]",
        error
      );


      return Response.json(
        {
          ok: false,

          error:
            error?.message ||
            "Internal error",
        },
        {
          status: 500,
        }
      );
    }
  },
};
