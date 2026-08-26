const AUTH_BASE = "https://auth.melcloudhome.com";
const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;

const API_BASE = "https://mobile.bff.melcloudhome.com";

const CLIENT_ID = "homemobile";
const REDIRECT_URI = "https://bridge-melhome-cloudflare.ohare-benjamin.workers.dev/oauth/callback";

const SCOPES = "openid profile email offline_access IdentityServerApi";

const USER_AGENT =
  "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";


// ============================================================
// D1 / OAUTH
// ============================================================

async function getOAuth(env) {
  return env.DB
    .prepare(
      "SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1"
    )
    .first();
}


async function saveOAuth(env, t) {
  if (!t?.refresh_token) {
    throw new Error("MELCloud n'a pas fourni de refresh_token");
  }

  const now = Date.now();

  const expires =
    t.expires_at ||
    now + Number(t.expires_in || 3600) * 1000;

  await env.DB
    .prepare("DELETE FROM oauth_tokens")
    .run();

  await env.DB
    .prepare(
      `INSERT INTO oauth_tokens
      (id, access_token, refresh_token, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      t.access_token || null,
      t.refresh_token,
      expires,
      now,
      now
    )
    .run();
}


// ============================================================
// TOKEN REFRESH
// ============================================================

async function refresh(env, row) {
  if (!row?.refresh_token) {
    throw new Error(
      "Aucun refresh_token MELCloud enregistré"
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: row.refresh_token,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },

    body: body.toString(),
  });

  if (!r.ok) {
    const detail = await r.text();

    throw new Error(
      `MELCloud OAuth refresh HTTP ${r.status}: ${detail.slice(
        0,
        300
      )}`
    );
  }

  const t = await r.json();

  // Certains serveurs OAuth ne renvoient pas
  // le refresh_token lors d'un refresh.
  if (!t.refresh_token) {
    t.refresh_token = row.refresh_token;
  }

  await saveOAuth(env, t);

  return t.access_token;
}


async function token(env) {
  const row = await getOAuth(env);

  if (!row) {
    throw new Error(
      "Aucun compte MELCloud OAuth enregistré"
    );
  }

  if (
    row.access_token &&
    Number(row.expires_at) >
      Date.now() + 300000
  ) {
    return row.access_token;
  }

  return refresh(env, row);
}


// ============================================================
// MELCLOUD API
// ============================================================

async function mel(env, path, opt = {}) {
  let t = await token(env);

  let r = await fetch(
    `${API_BASE}/${path.replace(/^\//, "")}`,
    {
      ...opt,

      headers: {
        Accept:
          "application/json, text/plain, */*",

        "User-Agent": USER_AGENT,

        ...(opt.headers || {}),

        Authorization: `Bearer ${t}`,
      },
    }
  );

  // Si le token est refusé, on le renouvelle une fois.
  if (r.status === 401) {
    const row = await getOAuth(env);

    t = await refresh(env, row);

    r = await fetch(
      `${API_BASE}/${path.replace(/^\//, "")}`,
      {
        ...opt,

        headers: {
          Accept:
            "application/json, text/plain, */*",

          "User-Agent": USER_AGENT,

          ...(opt.headers || {}),

          Authorization: `Bearer ${t}`,
        },
      }
    );
  }

  return r;
}


// ============================================================
// PKCE
// ============================================================

function b64url(bytes) {
  let binary = "";

  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}


async function createPKCE() {
  const verifierBytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );

  const verifier =
    b64url(verifierBytes);

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );

  const challenge =
    b64url(new Uint8Array(digest));

  return {
    verifier,
    challenge,
  };
}


// ============================================================
// COOKIE HELPERS
// ============================================================

function setCookie(name, value, maxAge = 600) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}


function getCookie(request, name) {
  const cookieHeader =
    request.headers.get("Cookie") || "";

  const cookies =
    cookieHeader.split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");

    if (index === -1) continue;

    const key =
      cookie.slice(0, index).trim();

    if (key !== name) continue;

    return decodeURIComponent(
      cookie.slice(index + 1).trim()
    );
  }

  return null;
}


// ============================================================
// OAUTH LOGIN
// ============================================================

async function startOAuth(request) {
  const { verifier, challenge } =
    await createPKCE();

  const state =
    b64url(
      crypto.getRandomValues(
        new Uint8Array(32)
      )
    );

  // ----------------------------------------------------------
  // Pushed Authorization Request
  // ----------------------------------------------------------

  const parBody =
    new URLSearchParams({
      response_type: "code",

      state,

      code_challenge: challenge,

      code_challenge_method: "S256",

      client_id: CLIENT_ID,

      scope: SCOPES,

      redirect_uri: REDIRECT_URI,
    });


  const par =
    await fetch(PAR_URL, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",

        Accept: "application/json",

        "User-Agent": USER_AGENT,
      },

      body: parBody.toString(),
    });


  if (!par.ok) {
    const detail =
      await par.text();

    throw new Error(
      `MELCloud PAR HTTP ${par.status}: ${detail.slice(
        0,
        300
      )}`
    );
  }


  const parData =
    await par.json();


  if (!parData.request_uri) {
    throw new Error(
      "MELCloud n'a pas fourni de request_uri"
    );
  }


  // ----------------------------------------------------------
  // URL officielle MELCloud
  // ----------------------------------------------------------

  const authorize =
    new URL(AUTHORIZE_URL);

  authorize.searchParams.set(
    "client_id",
    CLIENT_ID
  );

  authorize.searchParams.set(
    "request_uri",
    parData.request_uri
  );


  // ----------------------------------------------------------
  // On stocke temporairement le PKCE + state
  // dans des cookies HttpOnly.
  // ----------------------------------------------------------

  const headers =
    new Headers({
      Location:
        authorize.toString(),
      "Cache-Control":
        "no-store",
    });


  headers.append(
    "Set-Cookie",
    setCookie(
      "mel_oauth_verifier",
      verifier
    )
  );


  headers.append(
    "Set-Cookie",
    setCookie(
      "mel_oauth_state",
      state
    )
  );


  return new Response(null, {
    status: 302,
    headers,
  });
}


// ============================================================
// OAUTH CALLBACK
// ============================================================

async function oauthCallback(request, env) {
  const url =
    new URL(request.url);


  const error =
    url.searchParams.get("error");


  const errorDescription =
    url.searchParams.get(
      "error_description"
    );


  if (error) {
    return page(
      `
      <h1>❌ Connexion MELCloud refusée</h1>

      <p>
        ${escapeHtml(error)}
      </p>

      ${
        errorDescription
          ? `<p>${escapeHtml(
              errorDescription
            )}</p>`
          : ""
      }

      <p>
        <a href="/setup">
          Réessayer
        </a>
      </p>
      `,
      400
    );
  }


  const code =
    url.searchParams.get("code");


  if (!code) {
    return page(
      `
      <h1>❌ Code OAuth manquant</h1>

      <p>
        MELCloud n'a pas renvoyé de code
        d'autorisation.
      </p>

      <p>
        <a href="/setup">
          Réessayer
        </a>
      </p>
      `,
      400
    );
  }


  const verifier =
    getCookie(
      request,
      "mel_oauth_verifier"
    );


  const expectedState =
    getCookie(
      request,
      "mel_oauth_state"
    );


  const returnedState =
    url.searchParams.get("state");


  if (!verifier) {
    return page(
      `
      <h1>❌ Session OAuth expirée</h1>

      <p>
        La session de connexion a expiré.
      </p>

      <p>
        <a href="/setup">
          Recommencer la connexion
        </a>
      </p>
      `,
      400
    );
  }


  if (
    expectedState &&
    returnedState &&
    expectedState !== returnedState
  ) {
    return page(
      `
      <h1>❌ Erreur de sécurité OAuth</h1>

      <p>
        Le paramètre state ne correspond pas.
      </p>

      <p>
        <a href="/setup">
          Réessayer
        </a>
      </p>
      `,
      400
    );
  }


  // ----------------------------------------------------------
  // Exchange code -> tokens
  // ----------------------------------------------------------

  const tokenBody =
    new URLSearchParams({
      grant_type:
        "authorization_code",

      code,

      redirect_uri:
        REDIRECT_URI,

      code_verifier:
        verifier,

      client_id:
        CLIENT_ID,
    });


  const tokenResponse =
    await fetch(TOKEN_URL, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",

        Accept:
          "application/json",

        "User-Agent":
          USER_AGENT,
      },

      body:
        tokenBody.toString(),
    });


  if (!tokenResponse.ok) {
    const detail =
      await tokenResponse.text();

    return page(
      `
      <h1>❌ Échange OAuth impossible</h1>

      <p>
        MELCloud a répondu HTTP
        ${tokenResponse.status}.
      </p>

      <pre style="white-space:pre-wrap">${escapeHtml(
        detail.slice(0, 1000)
      )}</pre>

      <p>
        <a href="/setup">
          Réessayer
        </a>
      </p>
      `,
      400
    );
  }


  const tokens =
    await tokenResponse.json();


  if (!tokens.refresh_token) {
    return page(
      `
      <h1>❌ Refresh token manquant</h1>

      <p>
        MELCloud a accepté la connexion
        mais n'a pas fourni de refresh_token.
      </p>

      <p>
        <a href="/setup">
          Réessayer
        </a>
      </p>
      `,
      400
    );
  }


  // ----------------------------------------------------------
  // Sauvegarde D1
  // ----------------------------------------------------------

  await saveOAuth(
    env,
    tokens
  );


  // ----------------------------------------------------------
  // Nettoyage des cookies OAuth
  // ----------------------------------------------------------

  const headers =
    new Headers({
      "Cache-Control":
        "no-store",
    });


  headers.append(
    "Set-Cookie",
    setCookie(
      "mel_oauth_verifier",
      "",
      0
    )
  );


  headers.append(
    "Set-Cookie",
    setCookie(
      "mel_oauth_state",
      "",
      0
    )
  );


  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>MELHome Bridge</title>
</head>

<body style="
font-family:system-ui;
max-width:700px;
margin:40px auto;
padding:20px
">

<h1>✅ MELCloud connecté</h1>

<p>
La connexion MELCloud a été enregistrée
dans Cloudflare D1.
</p>

<p>
Le Worker pourra maintenant renouveler
automatiquement le token lorsque celui-ci
expire.
</p>

<p>
<a href="/api/status">
Vérifier le statut
</a>
</p>

</body>
</html>`,
    {
      status: 200,
      headers,
    }
  );
}


// ============================================================
// HTML HELPERS
// ============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function page(
  body,
  status = 200,
  extraHeaders = {}
) {
  return new Response(
    `<!doctype html>
<html lang="fr">

<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>MELHome Bridge</title>
</head>

<body style="
font-family:system-ui;
max-width:700px;
margin:40px auto;
padding:20px
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

        ...extraHeaders,
      },
    }
  );
}


// ============================================================
// MELCLOUD DEVICE HELPERS
// ============================================================

function setting(c, ks) {
  for (const k of ks) {
    if (c?.[k] != null) {
      return c[k];
    }
  }

  for (
    const n of [
      "settings",
      "unitSettings",
    ]
  ) {
    for (
      const x of
        Array.isArray(c?.[n])
          ? c[n]
          : []
    ) {
      if (
        ks.some(
          k =>
            k.toLowerCase() ===
            String(
              x?.name ??
              x?.Name ??
              ""
            ).toLowerCase()
        )
      ) {
        return (
          x?.value ??
          x?.Value ??
          null
        );
      }
    }
  }

  return null;
}


function on(c) {
  const v =
    setting(c, [
      "power",
      "Power",
    ]);

  return (
    v === true ||
    String(v).toLowerCase() ===
      "true"
  );
}


function room(c) {
  const n =
    Number.parseFloat(
      setting(c, [
        "roomTemperature",
        "RoomTemperature",
        "indoorTemperature",
        "IndoorTemperature",
      ])
    );

  return Number.isFinite(n) &&
    n > 0 &&
    n < 60
    ? n
    : 20;
}


function temp(c) {
  const n =
    Number.parseFloat(
      setting(c, [
        "setTemperature",
        "SetTemperature",
        "targetTemperature",
        "TargetTemperature",
        "defaultTemperature",
      ])
    );

  return Number.isFinite(n) &&
    n > 0 &&
    n < 60
    ? n
    : 20;
}


function mode(c) {
  if (!on(c)) {
    return "off";
  }

  const m =
    String(
      setting(c, [
        "operationMode",
        "OperationMode",
      ]) ||
        "Automatic"
    ).toLowerCase();

  if (m.includes("cool"))
    return "cool";

  if (m.includes("heat"))
    return "heat";

  if (m.includes("dry"))
    return "dry";

  if (m.includes("fan"))
    return "fan-only";

  return "auto";
}


function fan(c) {
  const s =
    String(
      setting(c, [
        "setFanSpeed",
        "SetFanSpeed",
        "fanSpeed",
        "FanSpeed",
      ]) ?? ""
    ).toLowerCase();

  return s.includes("one") ||
    s === "1"
    ? "One"
    : s.includes("two") ||
      s === "2"
    ? "Two"
    : s.includes("three") ||
      s === "3"
    ? "Three"
    : s.includes("four") ||
      s === "4"
    ? "Four"
    : s.includes("five") ||
      s === "5"
    ? "Five"
    : "Auto";
}


function devices(cs) {
  return cs.map(c => ({
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
          (n, i) => ({
            speed_name: n,

            speed_values: [
              {
                lang: "fr",

                speed_synonym: [
                  n,
                  i
                    ? `Vitesse ${i}`
                    : "Automatique",
                ],
              },

              {
                lang: "en",

                speed_synonym: [
                  n,
                  i
                    ? `Speed ${i}`
                    : "Automatic",
                ],
              },
            ],
          })
        ),

        ordered: true,
      },
    },
  }));
}


// ============================================================
// GOOGLE HOME FULFILLMENT
// ============================================================

async function fulfillment(
  req,
  env
) {
  const b =
    await req.json();

  const id =
    b?.requestId;

  const intent =
    b?.inputs?.[0]?.intent;


  if (
    !req.headers.get(
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


  const r =
    await mel(
      env,
      "context"
    );


  if (!r.ok) {
    return Response.json(
      {
        error:
          `MELCloud context HTTP ${r.status}`,
      },
      {
        status: 502,
      }
    );
  }


  const cs =
    (
      await r.json()
    )?.buildings?.[0]
      ?.airToAirUnits || [];


  // ----------------------------------------------------------
  // SYNC
  // ----------------------------------------------------------

  if (
    intent ===
    "action.devices.SYNC"
  ) {
    return Response.json({
      requestId: id,

      payload: {
        agentUserId:
          "melhome_user",

        devices:
          devices(cs),
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
    const d = {};

    for (const c of cs) {
      const x =
        String(
          c.id ?? c.ID
        );

      d[x] = {
        online: true,

        status:
          "SUCCESS",

        thermostatMode:
          mode(c),

        thermostatTemperatureSetpoint:
          temp(c),

        thermostatTemperatureAmbient:
          room(c),

        currentFanSpeedSetting:
          fan(c),
      };
    }


    return Response.json({
      requestId: id,

      payload: {
        devices: d,
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
    const out = [];


    for (
      const cmd of
        b?.inputs?.[0]
          ?.payload
          ?.commands || []
    ) {
      for (
        const dev of
          cmd.devices || []
      ) {
        const c =
          cs.find(
            x =>
              String(
                x.id ?? x.ID
              ) ===
              String(
                dev.id
              )
          );


        if (!c) {
          continue;
        }


        const p = {
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


        const s = {
          online: true,

          thermostatMode:
            mode(c),

          thermostatTemperatureSetpoint:
            temp(c),

          currentFanSpeedSetting:
            fan(c),
        };


        for (
          const e of
            cmd.execution ||
            []
        ) {
          if (
            e.command ===
            "action.devices.commands.OnOff"
          ) {
            p.power =
              !!e.params.on;

            s.thermostatMode =
              e.params.on
                ? "auto"
                : "off";
          }


          if (
            e.command ===
            "action.devices.commands.ThermostatTemperatureSetpoint"
          ) {
            p.setTemperature =
              e.params
                .thermostatTemperatureSetpoint;

            s.thermostatTemperatureSetpoint =
              e.params
                .thermostatTemperatureSetpoint;
          }


          if (
            e.command ===
            "action.devices.commands.ThermostatSetMode"
          ) {
            const m =
              e.params
                .thermostatMode;

            s.thermostatMode =
              m;


            if (
              m === "off"
            ) {
              p.power =
                false;
            } else {
              if (
                !on(c) &&
                p.power === null
              ) {
                p.power =
                  true;
              }


              p.operationMode =
                ({
                  cool: "Cool",

                  heat: "Heat",

                  dry: "Dry",

                  "fan-only":
                    "Fan",

                  auto:
                    "Automatic",
                })[m] ??
                null;
            }
          }


          if (
            e.command ===
            "action.devices.commands.SetFanSpeed"
          ) {
            p.setFanSpeed =
              e.params
                .fanSpeed;

            s.currentFanSpeedSetting =
              e.params
                .fanSpeed;
          }
        }


        const u =
          await mel(
            env,
            `monitor/ataunit/${encodeURIComponent(
              dev.id
            )}`,
            {
              method: "PUT",

              headers: {
                "Content-Type":
                  "application/json; charset=utf-8",
              },

              body:
                JSON.stringify(p),
            }
          );


        out.push(
          u.ok
            ? {
                ids: [
                  String(
                    dev.id
                  ),
                ],

                status:
                  "SUCCESS",

                states: s,
              }
            : {
                ids: [
                  String(
                    dev.id
                  ),
                ],

                status:
                  "ERROR",

                errorCode:
                  "hardError",
              }
        );
      }
    }


    return Response.json({
      requestId: id,

      payload: {
        commands: out,
      },
    });
  }


  return Response.json({
    requestId: id,

    payload: {},
  });
}


// ============================================================
// WORKER
// ============================================================

export default {
  async fetch(
    req,
    env
  ) {
    const u =
      new URL(req.url);


    try {

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/api/status"
      ) {
        const o =
          await getOAuth(env);


        return Response.json({
          ok: true,

          oauthSession:
            !!o?.refresh_token,

          tokenExpiresAt:
            o?.expires_at ??
            null,
        });
      }


      // ------------------------------------------------------
      // SETUP
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname === "/setup"
      ) {
        const o =
          await getOAuth(env);


        return page(`
          <h1>
            ❄️ MELHome Bridge
          </h1>

          <p>
            Connexion officielle
            à MELCloud Home.
          </p>

          <p>
            État OAuth :
            <b>
              ${
                o?.refresh_token
                  ? "CONFIGURE"
                  : "NON CONFIGURE"
              }
            </b>
          </p>

          <p>
            La connexion se fera
            directement sur la page
            officielle MELCloud.
          </p>

          <p>
            <a
              href="/oauth/start"
              style="
                display:inline-block;
                padding:12px 20px;
                background:#111;
                color:white;
                text-decoration:none;
                border-radius:8px;
              "
            >
              Se connecter avec MELCloud
            </a>
          </p>
        `);
      }


      // ------------------------------------------------------
      // START OAUTH
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/oauth/start"
      ) {
        return await startOAuth(
          req
        );
      }


      // ------------------------------------------------------
      // CALLBACK
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/oauth/callback"
      ) {
        return await oauthCallback(
          req,
          env
        );
      }


      // ------------------------------------------------------
      // MANUAL SAVE OAUTH
      // ------------------------------------------------------

      if (
        req.method === "POST" &&
        u.pathname ===
          "/api/save-oauth"
      ) {
        const b =
          await req.json();


        if (
          !b?.refresh_token
        ) {
          return Response.json(
            {
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
          b
        );


        return Response.json({
          success: true,
        });
      }


      // ------------------------------------------------------
      // GOOGLE HOME
      // ------------------------------------------------------

      if (
        req.method === "POST" &&
        u.pathname ===
          "/fulfillment"
      ) {
        return fulfillment(
          req,
          env
        );
      }


      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname ===
          "/health"
      ) {
        return Response.json({
          status: "ok",

          service:
            "melhome-bridge-cloudflare",
        });
      }


      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        u.pathname === "/"
      ) {
        const o =
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
                o?.refresh_token
                  ? "CONFIGURE"
                  : "NON CONFIGURE"
              }
            </b>
          </p>

          <p>
            <a href="/setup">
              Configurer MELCloud
            </a>
          </p>

          <p>
            <a href="/api/status">
              API Status
            </a>
          </p>
        `);
      }


      // ------------------------------------------------------
      // NOT FOUND
      // ------------------------------------------------------

      return new Response(
        "Not found",
        {
          status: 404,
        }
      );

    } catch (e) {

      console.error(
        "[MELHOME]",
        e
      );


      return Response.json(
        {
          error:
            e?.message ||
            "Internal error",
        },
        {
          status: 500,
        }
      );
    }
  },
};
