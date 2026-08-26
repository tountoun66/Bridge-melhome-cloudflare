const AUTH_BASE = "https://auth.melcloudhome.com";

const START_URL =
  `${AUTH_BASE}/connect/authorize`;

const CLIENT_ID =
  "3g4d5l5kivuqi7oia68gib7uso";

const REDIRECT_URI =
  "https://auth.melcloudhome.com/signin-oidc-meu";

const SCOPE =
  "openid profile";

function html(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MELCloud</title>
</head>
<body style="font-family:system-ui;max-width:800px;margin:40px auto;padding:20px">
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
    .replace(/"/g, "&quot;");
}

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

async function createPkce() {

  const verifier =
    b64url(
      crypto.getRandomValues(
        new Uint8Array(32)
      )
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );

  const challenge =
    b64url(
      new Uint8Array(digest)
    );

  return {
    verifier,
    challenge
  };
}


// ============================================================
// PAGE PRINCIPALE
// ============================================================

function home(request) {

  const url =
    new URL(request.url);

  return html(`

    <h1>❄️ MELCloud</h1>

    <p>
      Test de connexion officielle MELCloud.
    </p>

    <hr>

    <a href="/login">
      <button style="
        padding:14px 24px;
        font-size:17px;
        cursor:pointer;
      ">
        🔐 Se connecter à MELCloud
      </button>
    </a>

    <hr>

    <h3>Worker</h3>

    <pre>${esc(url.origin)}</pre>

  `);
}


// ============================================================
// DÉMARRAGE AUTHENTIFICATION
// ============================================================

async function login() {

  const {
    verifier,
    challenge
  } = await createPkce();

  /*
   * State généré pour cette tentative.
   */

  const state =
    crypto.randomUUID();

  /*
   * Nonce utilisé par le serveur OAuth.
   */

  const nonce =
    crypto.randomUUID();

  /*
   * IMPORTANT :
   *
   * On utilise le callback OFFICIEL MELCloud.
   */

  const authorize =
    new URL(
      START_URL
    );

  authorize.searchParams.set(
    "client_id",
    CLIENT_ID
  );

  authorize.searchParams.set(
    "redirect_uri",
    REDIRECT_URI
  );

  authorize.searchParams.set(
    "response_type",
    "code"
  );

  authorize.searchParams.set(
    "scope",
    SCOPE
  );

  authorize.searchParams.set(
    "code_challenge",
    challenge
  );

  authorize.searchParams.set(
    "code_challenge_method",
    "S256"
  );

  /*
   * Nous utilisons GET car ton URL réelle
   * montre bien :
   *
   * /signin-oidc-meu?code=...&state=...
   */

  authorize.searchParams.set(
    "response_mode",
    "query"
  );

  authorize.searchParams.set(
    "nonce",
    nonce
  );

  authorize.searchParams.set(
    "state",
    state
  );

  /*
   * On conserve les paramètres PKCE.
   *
   * Pour l'instant uniquement dans un cookie
   * de diagnostic.
   */

  const session =
    encodeURIComponent(
      JSON.stringify({
        state,
        nonce,
        verifier
      })
    );

  return new Response(null, {
    status: 302,

    headers: {

      Location:
        authorize.toString(),

      "Set-Cookie":
        `melcloud_test=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}


// ============================================================
// DIAGNOSTIC
// ============================================================

async function debug(request) {

  const url =
    new URL(request.url);

  return Response.json({
    ok: true,

    worker:
      url.origin,

    authBase:
      AUTH_BASE,

    authorize:
      START_URL,

    client_id:
      CLIENT_ID,

    redirect_uri:
      REDIRECT_URI,

    response_type:
      "code",

    response_mode:
      "query",

    scope:
      SCOPE
  });
}


// ============================================================
// SÉCURITÉ : NE PAS AFFICHER LES TOKENS
// ============================================================

function mask(value) {

  if (!value) {
    return null;
  }

  const s =
    String(value);

  if (s.length <= 12) {
    return "***";
  }

  return (
    s.slice(0, 6) +
    "..." +
    s.slice(-6)
  );
}


// ============================================================
// CALLBACK DE TEST
// ============================================================

async function callback(request) {

  const url =
    new URL(request.url);

  const code =
    url.searchParams.get(
      "code"
    );

  const state =
    url.searchParams.get(
      "state"
    );

  const error =
    url.searchParams.get(
      "error"
    );

  const errorDescription =
    url.searchParams.get(
      "error_description"
    );


  /*
   * Nous affichons uniquement ce que le Worker
   * reçoit réellement.
   */

  return html(`

    <h1>🔎 Résultat OAuth</h1>

    <p>
      Le Worker a reçu un callback.
    </p>

    <h3>Code</h3>

    <pre>${esc(
      code
        ? mask(code)
        : "aucun"
    )}</pre>

    <h3>State</h3>

    <pre>${esc(
      state
        ? mask(state)
        : "aucun"
    )}</pre>

    <h3>Erreur</h3>

    <pre>${esc(
      error || "aucune"
    )}</pre>

    <h3>Description</h3>

    <pre>${esc(
      errorDescription || "aucune"
    )}</pre>

    <hr>

    <p>
      <a href="/">
        Retour
      </a>
    </p>

  `);
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

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return home(request);
      }


      if (
        request.method === "GET" &&
        url.pathname === "/login"
      ) {
        return await login();
      }


      if (
        request.method === "GET" &&
        url.pathname === "/debug"
      ) {
        return debug(request);
      }


      /*
       * Cette route est seulement pour vérifier
       * le fonctionnement du callback.
       */

      if (
        request.method === "GET" &&
        url.pathname === "/callback"
      ) {
        return callback(request);
      }


      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return Response.json({
          status: "ok",
          service:
            "melhome-oauth-test"
        });
      }


      return new Response(
        "Not found",
        {
          status: 404
        }
      );

    } catch (error) {

      console.error(
        "[MELCLOUD]",
        error
      );

      return html(`

        <h1>❌ Erreur</h1>

        <pre>${esc(
          error?.stack ||
          error?.message ||
          String(error)
        )}</pre>

      `, 500);
    }
  }
};
