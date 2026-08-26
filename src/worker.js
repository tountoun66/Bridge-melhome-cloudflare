const COGNITO_LOGIN =
  "https://live-melcloudhome.auth.eu-west-1.amazoncognito.com/login";

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
<title>MELCloud OAuth</title>
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

async function createPkce() {
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
    b64url(
      new Uint8Array(digest)
    );

  return {
    verifier,
    challenge
  };
}

async function login(request) {

  const {
    verifier,
    challenge
  } = await createPkce();

  const state =
    crypto.randomUUID();

  const nonce =
    crypto.randomUUID();

  /*
   * IMPORTANT :
   *
   * On utilise exactement le client Web MELCloud
   * observé dans ton URL.
   */

  const url =
    new URL(COGNITO_LOGIN);

  url.searchParams.set(
    "client_id",
    CLIENT_ID
  );

  url.searchParams.set(
    "redirect_uri",
    REDIRECT_URI
  );

  url.searchParams.set(
    "response_type",
    "code"
  );

  url.searchParams.set(
    "scope",
    SCOPE
  );

  url.searchParams.set(
    "code_challenge",
    challenge
  );

  url.searchParams.set(
    "code_challenge_method",
    "S256"
  );

  /*
   * C'est le point important de ton URL.
   */

  url.searchParams.set(
    "response_mode",
    "form_post"
  );

  url.searchParams.set(
    "nonce",
    nonce
  );

  url.searchParams.set(
    "state",
    state
  );

  /*
   * On garde les informations PKCE temporairement
   * dans un cookie.
   */

  const data =
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
      Location: url.toString(),

      "Set-Cookie":
        `melcloud_oauth=${data}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

function readCookie(request, name) {

  const cookie =
    request.headers.get("Cookie") || "";

  const match =
    cookie.match(
      new RegExp(
        "(?:^|;\\s*)" +
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "=([^;]*)"
      )
    );

  return match
    ? decodeURIComponent(match[1])
    : null;
}

async function debug(request) {

  const url =
    new URL(request.url);

  return html(`
    <h1>🔎 MELCloud OAuth Test</h1>

    <p><b>Worker :</b></p>

    <pre>${url.origin}</pre>

    <p><b>Cognito :</b></p>

    <pre>${COGNITO_LOGIN}</pre>

    <p><b>Client ID :</b></p>

    <pre>${CLIENT_ID}</pre>

    <p><b>Redirect URI officiel :</b></p>

    <pre>${REDIRECT_URI}</pre>

    <p><b>Response mode :</b></p>

    <pre>form_post</pre>

    <hr>

    <p>
      <a href="/login">
        <button style="padding:12px 20px;font-size:16px">
          🔐 Connexion officielle MELCloud
        </button>
      </a>
    </p>
  `);
}

async function inspect(request) {

  const body =
    await request.text();

  return html(`
    <h1>📨 POST OAuth reçu</h1>

    <p>
      Cette page permet uniquement de vérifier
      les paramètres envoyés par MELCloud.
    </p>

    <h3>Body reçu</h3>

    <pre>${escapeHtml(body)}</pre>
  `);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    try {

      /*
       * Page de test
       */

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return debug(request);
      }

      /*
       * Départ vers Cognito officiel
       */

      if (
        request.method === "GET" &&
        url.pathname === "/login"
      ) {
        return login(request);
      }

      /*
       * Route de diagnostic POST.
       *
       * Elle ne sera utilisée que si un POST arrive
       * réellement sur le Worker.
       */

      if (
        request.method === "POST" &&
        url.pathname === "/callback"
      ) {
        return inspect(request);
      }

      /*
       * Healthcheck
       */

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return Response.json({
          ok: true,
          service: "melcloud-oauth-test",
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          responseMode: "form_post"
        });
      }

      return new Response(
        "Not found",
        { status: 404 }
      );

    } catch (error) {

      return html(`
        <h1>❌ Erreur</h1>

        <pre>${escapeHtml(
          error?.stack ||
          error?.message ||
          String(error)
        )}</pre>
      `, 500);
    }
  }
};
