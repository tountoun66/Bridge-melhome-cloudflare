const AUTH_BASE = "https://auth.melcloudhome.com";
const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;

const API_BASE = "https://mobile.bff.melcloudhome.com";

const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES = "openid profile email offline_access IdentityServerApi";

const USER_AGENT =
  "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";

const COGNITO_SUFFIX = ".amazoncognito.com";


// ============================================================
// D1 - OAUTH
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
      (id,access_token,refresh_token,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`
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
// REFRESH TOKEN
// ============================================================

async function refresh(env, row) {
  if (!row?.refresh_token) {
    throw new Error("Aucun refresh_token MELCloud enregistré");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: row.refresh_token,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },

    body: body.toString(),
  });

  if (!r.ok) {
    const detail = await r.text();

    throw new Error(
      `MELCloud OAuth refresh HTTP ${r.status}: ${detail.slice(0, 500)}`
    );
  }

  const t = await r.json();

  if (!t.refresh_token) {
    t.refresh_token = row.refresh_token;
  }

  await saveOAuth(env, t);

  return t.access_token;
}


// ============================================================
// ACCESS TOKEN
// ============================================================

async function token(env) {
  const row = await getOAuth(env);

  if (!row) {
    throw new Error("Aucun compte MELCloud OAuth enregistré");
  }

  if (
    row.access_token &&
    Number(row.expires_at) > Date.now() + 300000
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
        Accept: "application/json, text/plain, */*",
        "User-Agent": USER_AGENT,
        ...(opt.headers || {}),
        Authorization: `Bearer ${t}`,
      },
    }
  );

  if (r.status === 401) {
    t = await refresh(
      env,
      await getOAuth(env)
    );

    r = await fetch(
      `${API_BASE}/${path.replace(/^\//, "")}`,
      {
        ...opt,

        headers: {
          Accept: "application/json, text/plain, */*",
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
// COOKIES
// ============================================================

function setCookies(jar, response) {
  let values = [];

  try {
    if (
      typeof response.headers.getSetCookie ===
      "function"
    ) {
      values =
        response.headers.getSetCookie();
    }
  } catch (_) {}

  if (!values.length) {
    const raw =
      response.headers.get("set-cookie");

    if (raw) {
      values = raw.split(
        /,(?=\s*[^;,=\s]+=[^;,]+)/
      );
    }
  }

  for (const value of values) {
    const pair =
      value.split(";", 1)[0];

    const i = pair.indexOf("=");

    if (i > 0) {
      jar.set(
        pair.slice(0, i).trim(),
        pair.slice(i + 1).trim()
      );
    }
  }
}


function cookieHeader(jar) {
  return [...jar.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}


// ============================================================
// HTTP AVEC COOKIES + REDIRECTIONS
// ============================================================

async function httpWithCookies(
  url,
  init = {},
  jar = new Map(),
  maxRedirects = 10
) {
  let current = url;

  let options = {
    ...init,
    redirect: "manual",
  };

  for (let i = 0; i <= maxRedirects; i++) {
    const headers =
      new Headers(options.headers || {});

    const cookies = cookieHeader(jar);

    if (cookies) {
      headers.set("Cookie", cookies);
    }

    const response = await fetch(
      current,
      {
        ...options,
        headers,
        redirect: "manual",
      }
    );

    setCookies(jar, response);

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location =
        response.headers.get("location");

      if (!location) {
        return {
          response,
          url: current,
        };
      }

      const next =
        new URL(
          location,
          current
        ).toString();

      if (
        /^melcloudhome:\/\//i.test(next)
      ) {
        return {
          response,
          url: next,
        };
      }

      current = next;

      options = {
        method: "GET",

        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml",
        },
      };

      continue;
    }

    return {
      response,
      url: current,
    };
  }

  throw new Error(
    "Trop de redirections pendant l'authentification MELCloud"
  );
}


// ============================================================
// HTML HELPERS
// ============================================================

function extractCsrf(html) {
  const patterns = [
    /name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']_csrf["']/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);

    if (m) {
      return m[1];
    }
  }

  return null;
}


function extractFormAction(html, baseUrl) {
  const m =
    html.match(
      /<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/i
    ) ||
    html.match(/<form\b[^>]*>/i);

  if (!m) {
    return baseUrl;
  }

  const action = m[1] || "";

  try {
    return new URL(
      action || baseUrl,
      baseUrl
    ).toString();
  } catch (_) {
    return baseUrl;
  }
}


function extractHiddenInputs(html) {
  const out = {};

  const re =
    /<input\b[^>]*>/gi;

  for (
    const tag of html.match(re) || []
  ) {
    const type =
      (
        tag.match(
          /\btype=["']([^"']+)["']/i
        )?.[1] ||
        "hidden"
      ).toLowerCase();

    if (type !== "hidden") {
      continue;
    }

    const name =
      tag.match(
        /\bname=["']([^"']+)["']/i
      )?.[1];

    if (!name) {
      continue;
    }

    const value =
      tag.match(
        /\bvalue=["']([^"']*)["']/i
      )?.[1] ?? "";

    out[name] = value;
  }

  return out;
}


// ============================================================
// OAUTH CODE
// ============================================================

function extractCode(value) {
  const text = String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/\\u0026/g, "&");

  const direct =
    text.match(
      /[?&]code=([^&\s"'<>#]+)/i
    );

  if (direct) {
    try {
      return decodeURIComponent(
        direct[1]
      );
    } catch (_) {
      return direct[1];
    }
  }

  const encoded =
    text.match(
      /(?:code%3D|code\\u003d)([^&%\s"'<>#]+)/i
    );

  if (encoded) {
    try {
      return decodeURIComponent(
        encoded[1]
      );
    } catch (_) {
      return encoded[1];
    }
  }

  return null;
}


function extractOAuthError(value) {
  const text = String(value || "")
    .replace(/&amp;/gi, "&");

  const m =
    text.match(
      /[?&]error=([^&\s"'<>#]+)/i
    );

  if (!m) {
    return null;
  }

  let err = m[1];

  try {
    err = decodeURIComponent(err);
  } catch (_) {}

  const d =
    text.match(
      /[?&]error_description=([^&\s"'<>#]+)/i
    );

  if (d) {
    try {
      return `${err}: ${decodeURIComponent(
        d[1]
      )}`;
    } catch (_) {}
  }

  return err;
}


// ============================================================
// MELCLOUD LOGIN OAuth PKCE
// ============================================================

async function loginToMelcloud(
  email,
  password
) {
  const jar = new Map();

  // PKCE verifier
  const verifier =
    b64url(
      crypto.getRandomValues(
        new Uint8Array(32)
      )
    );

  // PKCE challenge
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        verifier
      )
    );

  const challenge =
    b64url(
      new Uint8Array(digest)
    );

  // OAuth state
  const state =
    b64url(
      crypto.getRandomValues(
        new Uint8Array(16)
      )
    );


  // ========================================================
  // PAR
  // ========================================================

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
    await fetch(
      PAR_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },

        body:
          parBody.toString(),
      }
    );

  if (par.status !== 201) {
    const detail =
      await par.text();

    throw new Error(
      `MELCloud PAR HTTP ${par.status}: ${detail.slice(
        0,
        500
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


  // ========================================================
  // AUTHORIZE
  // ========================================================

  const authorize =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(
      CLIENT_ID
    )}&request_uri=${encodeURIComponent(
      parData.request_uri
    )}`;


  const first =
    await httpWithCookies(
      authorize,
      {
        method: "GET",

        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml",
        },
      },
      jar
    );


  let authCode =
    extractCode(first.url);

  if (authCode) {
    return await exchangeCode(
      authCode,
      verifier
    );
  }


  const finalHost =
    (() => {
      try {
        return (
          new URL(first.url)
            .hostname || ""
        );
      } catch (_) {
        return "";
      }
    })();


  const body =
    await first.response.text();


  // ========================================================
  // ERREUR OAUTH
  // ========================================================

  const firstError =
    extractOAuthError(first.url) ||
    extractOAuthError(body);

  if (firstError) {
    throw new Error(
      `MELCloud OAuth: ${firstError}`
    );
  }


  // ========================================================
  // COGNITO LOGIN
  // ========================================================

  if (
    finalHost.endsWith(
      COGNITO_SUFFIX
    ) &&
    /\/login/i.test(first.url)
  ) {
    const csrf =
      extractCsrf(body);

    if (!csrf) {
      throw new Error(
        "Impossible de récupérer le jeton CSRF MELCloud"
      );
    }


    const action =
      extractFormAction(
        body,
        first.url
      );


    const hidden =
      extractHiddenInputs(body);

    hidden._csrf = csrf;
    hidden.username = email;
    hidden.password = password;


    if (
      !Object.prototype.hasOwnProperty.call(
        hidden,
        "cognitoAsfData"
      )
    ) {
      hidden.cognitoAsfData = "";
    }


    const form =
      new URLSearchParams();


    for (
      const [k, v] of Object.entries(
        hidden
      )
    ) {
      form.set(
        k,
        String(v)
      );
    }


    // ======================================================
    // POST LOGIN
    // ======================================================

    const logged =
      await httpWithCookies(
        action,
        {
          method: "POST",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76",

            "Content-Type":
              "application/x-www-form-urlencoded",

            Origin:
              `https://${finalHost}`,

            Referer:
              first.url,

            Accept:
              "text/html,application/xhtml+xml",
          },

          body:
            form.toString(),
        },
        jar
      );


    // ======================================================
    // CODE DIRECTEMENT DANS URL
    // ======================================================

    authCode =
      extractCode(
        logged.url
      );

    if (authCode) {
      return await exchangeCode(
        authCode,
        verifier
      );
    }


    // ======================================================
    // CODE DANS BODY
    // ======================================================

    const loggedBody =
      await logged.response.text();


    authCode =
      extractCode(
        loggedBody
      );

    if (authCode) {
      return await exchangeCode(
        authCode,
        verifier
      );
    }


    // ======================================================
    // ERREUR OAUTH DANS URL/BODY
    // ======================================================

    const err =
      extractOAuthError(
        logged.url
      ) ||
      extractOAuthError(
        loggedBody
      );

    if (err) {
      throw new Error(
        `MELCloud OAuth après connexion: ${err}`
      );
    }


    // ======================================================
    // CALLBACK POSSIBLE DANS HTML
    // ======================================================

    const callbackMatches = [
      logged.url,

      ...Array.from(
        loggedBody.matchAll(
          /(?:href|action|location)=["']([^"']*\/connect\/authorize\/callback\?[^"']*)["']/gi
        )
      ).map(
        m => m[1]
      ),

      ...Array.from(
        loggedBody.matchAll(
          /(\/connect\/authorize\/callback\?[^"'\s<>]+)/gi
        )
      ).map(
        m => m[1]
      ),
    ];


    for (
      const candidate of callbackMatches
    ) {
      try {
        const callbackUrl =
          new URL(
            candidate,
            logged.url
          ).toString();

        const callbackResult =
          await httpWithCookies(
            callbackUrl,
            {
              method: "GET",

              headers: {
                "User-Agent":
                  USER_AGENT,

                Accept:
                  "text/html,application/xhtml+xml",
              },
            },
            jar
          );


        authCode =
          extractCode(
            callbackResult.url
          ) ||
          extractCode(
            await callbackResult.response.text()
          );


        if (authCode) {
          return await exchangeCode(
            authCode,
            verifier
          );
        }
      } catch (_) {}
    }


    // ======================================================
    // CODE ÉVENTUELLEMENT DANS ACTION
    // ======================================================

    const formActionCode =
      extractCode(action);

    if (formActionCode) {
      return await exchangeCode(
        formActionCode,
        verifier
      );
    }


    // ======================================================
    // NOUVEAU DEBUG IMPORTANT
    // ======================================================

    const errorText =
      loggedBody
        .replace(
          /<script[\s\S]*?<\/script>/gi,
          " "
        )
        .replace(
          /<style[\s\S]*?<\/style>/gi,
          " "
        )
        .replace(
          /<[^>]+>/g,
          " "
        )
        .replace(
          /\s+/g,
          " "
        )
        .trim();


    throw new Error(
      `Connexion MELCloud refusée ou redirection OAuth introuvable ` +
      `(HTTP ${logged.response.status}, URL ${logged.url}, ` +
      `DETAIL=${errorText.slice(0, 1500)})`
    );
  }


  // ========================================================
  // CODE DANS LA PAGE INITIALE
  // ========================================================

  authCode =
    extractCode(body);

  if (authCode) {
    return await exchangeCode(
      authCode,
      verifier
    );
  }


  throw new Error(
    `MELCloud n'a pas renvoyé de code OAuth ` +
    `(étape ${finalHost || "inconnue"}, HTTP ${first.response.status}, URL ${first.url})`
  );
}


// ============================================================
// TOKEN EXCHANGE
// ============================================================

async function exchangeCode(
  authCode,
  verifier
) {
  const tokenBody =
    new URLSearchParams({
      grant_type:
        "authorization_code",

      code:
        authCode,

      redirect_uri:
        REDIRECT_URI,

      code_verifier:
        verifier,

      client_id:
        CLIENT_ID,
    });


  const tokenResponse =
    await fetch(
      TOKEN_URL,
      {
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
      }
    );


  if (!tokenResponse.ok) {
    const detail =
      await tokenResponse.text();

    throw new Error(
      `MELCloud échange OAuth HTTP ${tokenResponse.status}: ${detail.slice(
        0,
        500
      )}`
    );
  }


  const tokens =
    await tokenResponse.json();


  if (!tokens.refresh_token) {
    throw new Error(
      "MELCloud n'a pas renvoyé de refresh_token"
    );
  }


  return tokens;
}


// ============================================================
// BASE64 URL
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


// ============================================================
// MELCLOUD DATA HELPERS
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
      const x of Array.isArray(c?.[n])
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


// ============================================================
// GOOGLE HOME DEVICES
// ============================================================

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

    willReportState: false,

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
        status: "SUCCESS",
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


  if (
    intent ===
    "action.devices.EXECUTE"
  ) {
    const out = [];


    for (
      const cmd of
      b?.inputs?.[0]?.payload
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
              String(dev.id)
          );


        if (!c) {
          continue;
        }


        const p = {
          power: null,
          operationMode: null,
          setFanSpeed: null,
          setTemperature: null,
          vaneHorizontalDirection:
            null,
          vaneVerticalDirection:
            null,
          temperatureIncrementOverride:
            null,
          inStandbyMode: null,
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
          cmd.execution || []
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


            if (m === "off") {
              p.power = false;
            } else {
              if (
                !on(c) &&
                p.power === null
              ) {
                p.power = true;
              }

              p.operationMode =
                ({
                  cool: "Cool",
                  heat: "Heat",
                  dry: "Dry",
                  "fan-only": "Fan",
                  auto: "Automatic",
                })[m] ??
                null;
            }
          }


          if (
            e.command ===
            "action.devices.commands.SetFanSpeed"
          ) {
            p.setFanSpeed =
              e.params.fanSpeed;

            s.currentFanSpeedSetting =
              e.params.fanSpeed;
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
// HTML PAGE
// ============================================================

function page(
  body,
  status = 200
) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:700px;margin:40px auto;padding:20px">
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
// WORKER
// ============================================================

export default {
  async fetch(req, env) {
    const u =
      new URL(req.url);


    try {

      // ======================================================
      // STATUS
      // ======================================================

      if (
        req.method === "GET" &&
        u.pathname === "/api/status"
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


      // ======================================================
      // SETUP GET
      // ======================================================

      if (
        req.method === "GET" &&
        u.pathname === "/setup"
      ) {
        const o =
          await getOAuth(env);


        return page(`
<h1>❄️ MELHome Bridge</h1>

<p>
Connexion directe à MELCloud Home.
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

<form
  method="POST"
  action="/setup"
>

<label>
E-mail MELCloud
</label>

<br>

<input
  name="email"
  type="email"
  autocomplete="username"
  required
  style="width:100%;padding:10px;margin:6px 0 14px"
>

<label>
Mot de passe MELCloud
</label>

<br>

<input
  name="password"
  type="password"
  autocomplete="current-password"
  required
  style="width:100%;padding:10px;margin:6px 0 14px"
>

<button
  type="submit"
  style="padding:10px 18px"
>
Connecter MELCloud
</button>

</form>

<p style="font-size:13px">
Le Worker utilise ces identifiants uniquement pendant cette requête pour obtenir le refresh_token OAuth.
Ils ne sont pas enregistrés dans D1.
</p>
`);
      }


      // ======================================================
      // SETUP POST
      // ======================================================

      if (
        req.method === "POST" &&
        u.pathname === "/setup"
      ) {
        const f =
          await req.formData();


        const email =
          String(
            f.get("email") ||
            ""
          ).trim();


        const password =
          String(
            f.get("password") ||
            ""
          );


        if (
          !email ||
          !password
        ) {
          return page(
            `<h2>Identifiants manquants</h2>
             <p><a href="/setup">Retour</a></p>`,
            400
          );
        }


        try {

          const tokens =
            await loginToMelcloud(
              email,
              password
            );


          await saveOAuth(
            env,
            tokens
          );


          return page(`
<h1>✅ MELCloud connecté</h1>

<p>
Le refresh_token OAuth est maintenant enregistré dans D1.
</p>

<p>
<a href="/api/status">
Vérifier le statut
</a>
</p>
`);
        } catch (e) {

          const message =
            String(
              e?.message || e
            ).replace(
              /[&<>]/g,
              c =>
                ({
                  "&":
                    "&amp;",
                  "<":
                    "&lt;",
                  ">":
                    "&gt;",
                })[c]
            );


          return page(`
<h2>
❌ Connexion MELCloud impossible
</h2>

<p>
${message}
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
      }


      // ======================================================
      // SAVE OAUTH
      // ======================================================

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


      // ======================================================
      // GOOGLE HOME
      // ======================================================

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


      // ======================================================
      // HEALTH
      // ======================================================

      if (
        req.method === "GET" &&
        u.pathname === "/health"
      ) {
        return Response.json({
          status: "ok",
          service:
            "melhome-bridge-cloudflare",
        });
      }


      // ======================================================
      // HOME
      // ======================================================

      if (
        req.method === "GET" &&
        u.pathname === "/"
      ) {
        const o =
          await getOAuth(env);


        return page(`
<h1>❄️ MELHome Bridge</h1>

<p>
Cloudflare opérationnel
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
`);
      }


      // ======================================================
      // 404
      // ======================================================

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
