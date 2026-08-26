const AUTH_BASE = "https://auth.melcloudhome.com";

const WEB_CLIENT_ID = "3g4d5l5kivuqi7oia68gib7uso";

const MELCLOUD_CALLBACK =
  "https://auth.melcloudhome.com/signin-oidc-meu";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36";


// ============================================================
// HTML
// ============================================================

function page(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MELCloud OAuth Test</title>
</head>

<body style="
font-family:system-ui;
max-width:800px;
margin:40px auto;
padding:20px;
">

${body}

</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html;charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}


// ============================================================
// ÉCHAPPEMENT HTML
// ============================================================

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ============================================================
// PAGE D'ACCUEIL
// ============================================================

function home() {
  return page(`
    <h1>❄️ MELCloud OAuth Test</h1>

    <p>
      Test minimal du système d'authentification Web MELCloud.
    </p>

    <hr>

    <p>
      <a href="/login">
        <button style="
          padding:12px 20px;
          font-size:16px;
          cursor:pointer;
        ">
          🔐 Se connecter à MELCloud
        </button>
      </a>
    </p>

    <hr>

    <h3>Configuration détectée</h3>

    <pre>
Client ID :
${esc(WEB_CLIENT_ID)}

Callback MELCloud :
${esc(MELCLOUD_CALLBACK)}

Worker :
${esc("https://bridge-melhome-cloudflare.ohare-benjamin.workers.dev")}
    </pre>
  `);
}


// ============================================================
// LOGIN
// ============================================================

async function login() {

  /*
   * Pour ce premier test, nous ne faisons PAS de PAR.
   *
   * Nous reproduisons directement la requête Web que nous
   * avons observée dans ton erreur :
   *
   * client_id =
   * 3g4d5l5kivuqi7oia68gib7uso
   *
   * redirect_uri =
   * https://auth.melcloudhome.com/signin-oidc-meu
   *
   * Le but est de laisser MELCloud construire lui-même
   * sa session Cognito.
   */


  const state =
    crypto.randomUUID();


  const nonce =
    crypto.randomUUID();


  const verifierBytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );


  let binary = "";

  for (
    const byte of verifierBytes
  ) {
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


  /*
   * On mémorise temporairement les valeurs dans un cookie.
   *
   * Cela permettra au Worker de retrouver le state/code_verifier
   * lorsque MELCloud reviendra.
   */

  const cookieValue =
    encodeURIComponent(
      JSON.stringify({
        state,
        nonce,
        verifier,
      })
    );


  const authorize =
    new URL(
      `${AUTH_BASE}/connect/authorize`
    );


  authorize.searchParams.set(
    "client_id",
    WEB_CLIENT_ID
  );


  authorize.searchParams.set(
    "redirect_uri",
    MELCLOUD_CALLBACK
  );


  authorize.searchParams.set(
    "response_type",
    "code"
  );


  authorize.searchParams.set(
    "scope",
    "openid profile"
  );


  authorize.searchParams.set(
    "code_challenge",
    challenge
  );


  authorize.searchParams.set(
    "code_challenge_method",
    "S256"
  );


  authorize.searchParams.set(
    "nonce",
    nonce
  );


  authorize.searchParams.set(
    "state",
    state
  );


  return new Response(null, {
    status: 302,

    headers: {
      Location:
        authorize.toString(),

      "Set-Cookie":
        `mel_oauth=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}


// ============================================================
// DIAGNOSTIC CALLBACK
// ============================================================

async function callback(request) {

  const url =
    new URL(request.url);


  /*
   * Cette route ne devrait normalement PAS être appelée
   * puisque le redirect_uri officiel observé est :
   *
   * https://auth.melcloudhome.com/signin-oidc-meu
   *
   * Mais on la garde pour pouvoir tester si MELCloud accepte
   * éventuellement une URL Worker plus tard.
   */


  const params =
    Object.fromEntries(
      url.searchParams.entries()
    );


  return page(`
    <h1>🔎 Callback reçu</h1>

    <p>
      Le Worker a reçu une réponse OAuth.
    </p>

    <h3>Paramètres</h3>

    <pre>${esc(
      JSON.stringify(
        params,
        null,
        2
      )
    )}</pre>

    <p>
      <a href="/">
        Retour
      </a>
    </p>
  `);
}


// ============================================================
// DEBUG MELCLOUD
// ============================================================

async function debug() {

  const result = {
    worker: true,

    time:
      new Date().toISOString(),

    authBase:
      AUTH_BASE,

    clientId:
      WEB_CLIENT_ID,

    redirectUri:
      MELCLOUD_CALLBACK,

    authorize:
      `${AUTH_BASE}/connect/authorize`,
  };


  return Response.json(
    result,
    {
      headers: {
        "cache-control":
          "no-store",
      },
    }
  );
}


// ============================================================
// FETCH
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
      // /
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return home();
      }


      // ------------------------------------------------------
      // /login
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/login"
      ) {
        return await login();
      }


      // ------------------------------------------------------
      // /callback
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/callback"
      ) {
        return await callback(
          request
        );
      }


      // ------------------------------------------------------
      // /debug
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/debug"
      ) {
        return await debug();
      }


      // ------------------------------------------------------
      // /health
      // ------------------------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return Response.json({
          status: "ok",
          service:
            "melhome-oauth-test",
        });
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
        "[MELCLOUD TEST]",
        error
      );


      return page(`
        <h1>❌ Erreur</h1>

        <pre>${esc(
          error?.stack ||
          error?.message ||
          String(error)
        )}</pre>

        <p>
          <a href="/">
            Retour
          </a>
        </p>
      `, 500);
    }
  },
};
