const MELCLOUD_HOME = "https://melcloudhome.com";
const AUTH_BASE = "https://auth.melcloudhome.com";

const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;

const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";

const SCOPES = "openid profile email offline_access IdentityServerApi";

const USER_AGENT =
  "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";

function html(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MELHome OAuth</title>
</head>
<body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px">
${body}
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html;charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function b64url(bytes) {
  let s = "";

  for (const b of bytes) {
    s += String.fromCharCode(b);
  }

  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/* ============================================================
   D1
   ============================================================ */

async function getOAuth(env) {
  if (!env.DB) {
    throw new Error("Binding D1 'DB' absent");
  }

  return await env.DB
    .prepare(
      "SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1"
    )
    .first();
}

async function saveOAuth(env, tokens) {
  if (!env.DB) {
    throw new Error("Binding D1 'DB' absent");
  }

  if (!tokens?.refresh_token) {
    throw new Error(
      "MELCloud n'a pas fourni de refresh_token"
    );
  }

  const now = Date.now();

  const expiresAt =
    tokens.expires_at ||
    now + Number(tokens.expires_in || 3600) * 1000;

  await env.DB.prepare(
    "DELETE FROM oauth_tokens"
  ).run();

  await env.DB.prepare(
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

/* ============================================================
   COOKIE JAR
   ============================================================ */

function addCookies(jar, response) {
  let cookies = [];

  try {
    if (
      typeof response.headers.getSetCookie === "function"
    ) {
      cookies = response.headers.getSetCookie();
    }
  } catch {}

  if (!cookies.length) {
    const raw = response.headers.get("set-cookie");

    if (raw) {
      cookies = raw.split(
        /,(?=\s*[^;,=\s]+=[^;,]+)/
      );
    }
  }

  for (const cookie of cookies) {
    const part = cookie.split(";", 1)[0];

    const index = part.indexOf("=");

    if (index <= 0) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/* ============================================================
   HTTP
   ============================================================ */

async function requestWithCookies(
  url,
  init,
  jar
) {
  const headers = new Headers(
    init?.headers || {}
  );

  const cookies = cookieHeader(jar);

  if (cookies) {
    headers.set("Cookie", cookies);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual"
  });

  addCookies(jar, response);

  return response;
}

/* ============================================================
   CODE OAUTH
   ============================================================ */

function extractCode(value) {
  if (!value) return null;

  const text = String(value);

  const match = text.match(
    /[?&]code=([^&\s"'<>]+)/i
  );

  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/* ============================================================
   FORM HTML
   ============================================================ */

function extractForm(body, baseUrl) {
  if (!body) return null;

  const match = String(body).match(
    /<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i
  );

  if (!match) {
    return null;
  }

  // 💡 CORRECTION 1 : Nettoyage des entités HTML dans l'attribut action
  const rawAction = match[1].replace(/&amp;/g, "&");

  const action = new URL(
    rawAction,
    baseUrl
  ).toString();

  const data = new URLSearchParams();

  const inputs = match[2].matchAll(
    /<input[^>]*>/gi
  );

  for (const item of inputs) {
    const tag = item[0];

    const name =
      tag.match(
        /name=["']([^"']+)["']/i
      )?.[1];

    const value =
      tag.match(
        /value=["']([^"']*)["']/i
      )?.[1] ?? "";

    if (name) {
      data.set(name, value);
    }
  }

  return {
    action,
    data
  };
}

/* ============================================================
   DIAGNOSTIC
   ============================================================ */

async function diagnosticRequest(
  url,
  init,
  jar,
  diagnostics
) {
  const response =
    await requestWithCookies(
      url,
      init,
      jar
    );

  diagnostics.push({
    url: maskUrl(url),
    method: init?.method || "GET",
    status: response.status,
    contentType:
      response.headers.get("content-type"),
    location:
      maskUrl(response.headers.get("location")),
    setCookie:
      !!response.headers.get("set-cookie")
  });

  return response;
}

function maskUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);

    const sensitive = [
      "code",
      "state",
      "nonce",
      "request_uri",
      "code_challenge",
      "code_verifier",
      "id_token",
      "access_token",
      "refresh_token"
    ];

    for (const key of sensitive) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "***");
      }
    }

    return url.toString();
  } catch {
    return String(value)
      .replace(
        /([?&](?:code|state|nonce|request_uri|code_challenge|code_verifier|access_token|refresh_token)=)[^&]+/gi,
        "$1***"
      );
  }
}

/* ============================================================
   FOLLOW REDIRECTS
   ============================================================ */

async function followOAuth(
  startUrl,
  jar,
  diagnostics,
  max = 20
) {
  let currentUrl = startUrl;

  let init = {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  };

  for (let i = 0; i < max; i++) {
    const response =
      await diagnosticRequest(
        currentUrl,
        init,
        jar,
        diagnostics
      );

    const location =
      response.headers.get("location");

    if (location) {
      const nextUrl =
        new URL(
          location,
          currentUrl
        ).toString();

      if (
        /^melcloud:\/\//i.test(nextUrl)
      ) {
        return {
          url: nextUrl,
          response
        };
      }

      currentUrl = nextUrl;

      init = {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml"
        }
      };

      continue;
    }

    const body = await response.text();

    const code =
      extractCode(currentUrl) ||
      extractCode(body);

    if (code) {
      return {
        url: currentUrl,
        response,
        body
      };
    }

    const form =
      extractForm(
        body,
        currentUrl
      );

    if (form) {
      // 💡 CORRECTION 2 : On stoppe l'auto-soumission si on est sur Cognito.
      if (currentUrl.includes("amazoncognito.com")) {
        return {
          url: currentUrl,
          response,
          body
        };
      }

      currentUrl = form.action;

      init = {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type":
            "application/x-www-form-urlencoded",
          Referer: currentUrl,
          Accept:
            "text/html,application/xhtml+xml"
        },
        body: form.data.toString()
      };

      continue;
    }

    return {
      url: currentUrl,
      response,
      body
    };
  }

  throw new Error(
    "Trop de redirections MELCloud"
  );
}

/* ============================================================
   OAUTH LOGIN
   ============================================================ */

async function loginToMelcloud(
  email,
  password,
  diagnostics
) {
  const jar = new Map();

  /* PKCE */

  const verifierBytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );

  const verifier =
    b64url(verifierBytes);

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

  const state =
    b64url(
      crypto.getRandomValues(
        new Uint8Array(16)
      )
    );

  /* PAR */

  const par =
    await diagnosticRequest(
      PAR_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": USER_AGENT
        },
        body:
          new URLSearchParams({
            response_type: "code",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            client_id: CLIENT_ID,
            scope: SCOPES,
            redirect_uri: REDIRECT_URI
          }).toString()
      },
      jar,
      diagnostics
    );

  const parText =
    await par.text();

  if (!par.ok) {
    throw new Error(
      `MELCloud PAR HTTP ${par.status}: ${parText.slice(
        0,
        300
      )}`
    );
  }

  let parData;

  try {
    parData =
      JSON.parse(parText);
  } catch {
    throw new Error(
      "Réponse PAR MELCloud invalide"
    );
  }

  if (!parData.request_uri) {
    throw new Error(
      "MELCloud n'a pas fourni de request_uri"
    );
  }

  /* AUTHORIZE */

  const authorizeUrl =
    `${AUTHORIZE_URL}?client_id=${encodeURIComponent(
      CLIENT_ID
    )}&request_uri=${encodeURIComponent(
      parData.request_uri
    )}`;

  let result =
    await followOAuth(
      authorizeUrl,
      jar,
      diagnostics
    );

  let host = "";

  try {
    host =
      new URL(result.url)
        .hostname
        .toLowerCase();
  } catch {}

  /*
   * IMPORTANT :
   *
   * Nous ne faisons plus l'hypothèse
   * qu'un champ _csrf existe.
   */

  if (
    !extractCode(result.url) &&
    host.includes(
      "amazoncognito.com"
    )
  ) {
    const body =
      result.body ??
      await result.response.text();

    const form =
      extractForm(
        body,
        result.url
      );

    /*
     * Diagnostic uniquement.
     *
     * On regarde les champs présents
     * sans afficher leurs valeurs.
     */

    const fieldNames = [];

    if (form) {
      for (
        const key of form.data.keys()
      ) {
        fieldNames.push(key);
      }
    }

    diagnostics.push({
      type: "cognito_login_form",
      formAction:
        form
          ? maskUrl(form.action)
          : null,
      fields:
        fieldNames.map(
          name =>
            name.toLowerCase().includes(
              "password"
            )
              ? "password"
              : name.toLowerCase().includes(
                  "user"
                )
              ? "username"
              : name
        )
    });

    /*
     * Si Cognito nous présente un formulaire,
     * on cherche les champs réellement utilisés.
     */

    if (!form) {
      throw new Error(
        "Cognito n'a pas fourni de formulaire de connexion exploitable"
      );
    }

    const usernameField =
      [...form.data.keys()].find(
        key =>
          /^(username|email|login)$/i.test(
            key
          )
      );

    const passwordField =
      [...form.data.keys()].find(
        key =>
          /password/i.test(key)
      );

    if (
      !usernameField ||
      !passwordField
    ) {
      throw new Error(
        `Formulaire Cognito inattendu. Champs détectés : ${fieldNames.join(
          ", "
        )}`
      );
    }

    form.data.set(
      usernameField,
      email
    );

    form.data.set(
      passwordField,
      password
    );

    const login =
      await diagnosticRequest(
        form.action,
        {
          method: "POST",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76",
            "Content-Type":
              "application/x-www-form-urlencoded",
            Origin:
              `https://${host}`,
            Referer:
              result.url,
            Accept:
              "text/html,application/xhtml+xml,application/xml"
          },
          body:
            form.data.toString()
        },
        jar,
        diagnostics
      );

    const location =
      login.headers.get(
        "location"
      );

    if (location) {
      result =
        await followOAuth(
          new URL(
            location,
            result.url
          ).toString(),
          jar,
          diagnostics
        );
    } else {
      const body2 =
        await login.text();

      const code =
        extractCode(body2);

      if (code) {
        result = {
          url:
            `${REDIRECT_URI}?code=${encodeURIComponent(
              code
            )}`
        };
      } else {
        const form2 =
          extractForm(
            body2,
            form.action
          );

        if (form2) {
          result =
            await followOAuth(
              form2.action,
              jar,
              diagnostics
            );
        }
      }
    }
  }

  /* CODE */

  const authorizationCode =
    extractCode(result.url) ||
    extractCode(result.body);

  if (!authorizationCode) {
    throw new Error(
      "MELCloud n'a pas renvoyé de code OAuth"
    );
  }

  /* TOKEN */

  const tokenResponse =
    await diagnosticRequest(
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": USER_AGENT
        },
        body:
          new URLSearchParams({
            grant_type:
              "authorization_code",
            code:
              authorizationCode,
            redirect_uri:
              REDIRECT_URI,
            code_verifier:
              verifier,
            client_id:
              CLIENT_ID
          }).toString()
      },
      jar,
      diagnostics
    );

  const tokenText =
    await tokenResponse.text();

  if (!tokenResponse.ok) {
    throw new Error(
      `Échange OAuth HTTP ${tokenResponse.status}: ${tokenText.slice(
        0,
        300
      )}`
    );
  }

  let tokens;

  try {
    tokens =
      JSON.parse(tokenText);
  } catch {
    throw new Error(
      "Réponse token MELCloud invalide"
    );
  }

  if (!tokens.refresh_token) {
    throw new Error(
      "MELCloud n'a pas fourni de refresh_token"
    );
  }

  return tokens;
}

/* ============================================================
   REFRESH TOKEN
   ============================================================ */

async function refreshToken(
  env,
  row
) {
  if (!row?.refresh_token) {
    throw new Error(
      "Aucun refresh_token MELCloud enregistré"
    );
  }

  const response =
    await fetch(
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent":
            USER_AGENT
        },
        body:
          new URLSearchParams({
            grant_type:
              "refresh_token",
            client_id:
              CLIENT_ID,
            refresh_token:
              row.refresh_token
          }).toString()
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Refresh MELCloud HTTP ${response.status}: ${text.slice(
        0,
        300
      )}`
    );
  }

  const tokens =
    JSON.parse(text);

  if (
    !tokens.refresh_token
  ) {
    tokens.refresh_token =
      row.refresh_token;
  }

  await saveOAuth(
    env,
    tokens
  );

  return tokens;
}

/* ============================================================
   WORKER
   ============================================================ */

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(request.url);

    try {
      /* HOME */

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        const oauth =
          await getOAuth(env);

        return html(`
<h1>❄️ MELHome OAuth</h1>

<p>
Token MELCloud :
<b>
${
  oauth?.refresh_token
    ? "ENREGISTRÉ"
    : "ABSENT"
}
</b>
</p>

<p>
<a href="/setup">
🔐 Connexion MELCloud
</a>
</p>

<p>
<a href="/api/status">
📊 État OAuth
</a>
</p>
`);
      }

      /* HEALTH */

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return Response.json({
          ok: true,
          service:
            "melhome-oauth",
          client_id:
            CLIENT_ID
        });
      }

      /* STATUS */

      if (
        request.method === "GET" &&
        url.pathname === "/api/status"
      ) {
        const oauth =
          await getOAuth(env);

        return Response.json({
          ok: true,
          authenticated:
            !!oauth?.refresh_token,
          expires_at:
            oauth?.expires_at ??
            null,
          has_refresh_token:
            !!oauth?.refresh_token
        });
      }

      /* SETUP */

      if (
        request.method === "GET" &&
        url.pathname === "/setup"
      ) {
        const oauth =
          await getOAuth(env);

        return html(`
<h1>🔐 Connexion MELCloud</h1>

<p>
État :
<b>
${
  oauth?.refresh_token
    ? "TOKEN ENREGISTRÉ"
    : "NON CONNECTÉ"
}
</b>
</p>

<form method="post">

<input
name="email"
type="email"
autocomplete="username"
placeholder="E-mail"
required
style="width:100%;padding:10px">

<br><br>

<input
name="password"
type="password"
autocomplete="current-password"
placeholder="Mot de passe"
required
style="width:100%;padding:10px">

<br><br>

<button
style="padding:12px 20px">
Se connecter
</button>

</form>

<p style="font-size:13px;color:#666">
Le mot de passe est utilisé uniquement
pour cette tentative et n'est pas enregistré
dans D1.
</p>
`);
      }

      /* LOGIN */

      if (
        request.method === "POST" &&
        url.pathname === "/setup"
      ) {
        const form =
          await request.formData();

        const email =
          String(
            form.get("email") ||
              ""
          ).trim();

        const password =
          String(
            form.get("password") ||
              ""
          );

        if (
          !email ||
          !password
        ) {
          return html(
            "<h1>❌ Identifiants manquants</h1>",
            400
          );
        }

        const diagnostics = [];

        try {
          const tokens =
            await loginToMelcloud(
              email,
              password,
              diagnostics
            );

          await saveOAuth(
            env,
            tokens
          );

          return html(`
<h1>✅ Token MELCloud récupéré</h1>

<p>
Le refresh_token est enregistré dans D1.
</p>

<p>
<a href="/api/status">
Vérifier le statut
</a>
</p>
`);
        } catch (error) {
          console.error(
            "[MELHOME OAuth]",
            error
          );

          return html(`
<h1>❌ Connexion MELCloud impossible</h1>

<pre style="
white-space:pre-wrap;
background:#f5f5f5;
padding:15px;
overflow:auto
">${esc(
  error?.message ||
    String(error)
)}</pre>

<h3>Diagnostic du flux</h3>

<pre style="
white-space:pre-wrap;
background:#f5f5f5;
padding:15px;
overflow:auto
">${esc(
  JSON.stringify(
    diagnostics,
    null,
    2
  )
)}</pre>

<p>
<a href="/setup">
Réessayer
</a>
</p>
`, 400);
        }
      }

      /* REFRESH */

      if (
        request.method === "POST" &&
        url.pathname ===
          "/api/refresh"
      ) {
        const oauth =
          await getOAuth(env);

        const tokens =
          await refreshToken(
            env,
            oauth
          );

        return Response.json({
          ok: true,
          refreshed: true,
          expires_in:
            tokens.expires_in ??
            null,
          has_refresh_token:
            !!tokens.refresh_token
        });
      }

      /* DEBUG BFF */

      if (
        request.method === "GET" &&
        url.pathname ===
          "/debug/bff"
      ) {
        const response =
          await fetch(
            `${MELCLOUD_HOME}/bff/login?returnUrl=/dashboard`,
            {
              method: "GET",
              redirect: "manual",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
              }
            }
          );

        return Response.json({
          ok: true,
          status:
            response.status,
          location:
            maskUrl(
              response.headers.get(
                "location"
              )
            ),
          hasLocation:
            !!response.headers.get(
              "location"
            )
        });
      }

      return new Response(
        "Not found",
        {
          status: 404,
          headers: {
            "cache-control":
              "no-store"
          }
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
            String(error)
        },
        {
          status: 500
        }
      );
    }
  }
};
