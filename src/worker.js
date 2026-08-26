const MELCLOUD_HOME = "https://melcloudhome.com";
const AUTH_BASE = "https://auth.melcloudhome.com";

function page(body, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MELHome Bridge</title>
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {

      /*
       * ============================================================
       * LOGIN
       * ============================================================
       *
       * On utilise le BFF officiel de MELCloud Home.
       *
       * IMPORTANT :
       * Le callback Cognito (/signin-oidc-meu) est enregistré
       * chez MELCloud. On ne le remplace donc pas par une URL
       * Cloudflare arbitraire.
       */
      if (request.method === "GET" && url.pathname === "/login") {
        const returnUrl = url.searchParams.get("returnUrl") || "/dashboard";

        const loginUrl =
          `${MELCLOUD_HOME}/bff/login?returnUrl=` +
          encodeURIComponent(returnUrl);

        return Response.redirect(loginUrl, 302);
      }


      /*
       * ============================================================
       * PAGE PRINCIPALE
       * ============================================================
       */
      if (request.method === "GET" && url.pathname === "/") {
        return page(`
          <h1>❄️ MELHome Bridge</h1>

          <p>
            Connexion avec le flux officiel
            <b>MELCloud Home / BFF / Cognito</b>.
          </p>

          <p>
            <a href="/login">
              <button style="
                padding:12px 22px;
                font-size:16px;
                cursor:pointer
              ">
                🔐 Se connecter avec MELCloud
              </button>
            </a>
          </p>

          <hr>

          <h3>Flux d'authentification</h3>

          <pre style="
            background:#f5f5f5;
            padding:15px;
            overflow:auto
          ">Worker
  ↓
melcloudhome.com/bff/login
  ↓
auth.melcloudhome.com
  ↓
Cognito
  ↓
signin-oidc-meu
  ↓
ExternalLogin/Callback
  ↓
connect/authorize/callback
  ↓
MELCloud Home</pre>

          <p style="color:#666;font-size:14px">
            Le Worker ne demande pas directement les identifiants
            MELCloud. L'authentification est effectuée par MELCloud.
          </p>
        `);
      }


      /*
       * ============================================================
       * HEALTH
       * ============================================================
       */
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: "melhome-bridge-cloudflare",
          auth: "official-melcloud-bff",
          melcloud: MELCLOUD_HOME,
          authServer: AUTH_BASE,
          status: "ready"
        });
      }


      /*
       * ============================================================
       * TEST BFF
       * ============================================================
       *
       * Permet de vérifier que Cloudflare peut atteindre le BFF
       * sans modifier le flux d'authentification.
       */
      if (request.method === "GET" && url.pathname === "/debug/bff") {
        const response = await fetch(
          `${MELCLOUD_HOME}/bff/login?returnUrl=/dashboard`,
          {
            method: "GET",
            redirect: "manual",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/151.0.0.0 Safari/537.36",
              "Accept":
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
          }
        );

        const location = response.headers.get("location");

        return Response.json({
          ok: true,
          status: response.status,
          location: location || null,
          hasLocation: !!location
        });
      }


      /*
       * ============================================================
       * NOT FOUND
       * ============================================================
       */
      return new Response("Not found", {
        status: 404,
        headers: {
          "cache-control": "no-store"
        }
      });

    } catch (error) {
      console.error("[MELHOME]", error);

      return page(
        `
        <h1>❌ Erreur MELHome Bridge</h1>

        <pre style="
          white-space:pre-wrap;
          background:#f5f5f5;
          padding:15px;
          overflow:auto
        ">${esc(error?.stack || error?.message || String(error))}</pre>
        `,
        500
      );
    }
  }
};
