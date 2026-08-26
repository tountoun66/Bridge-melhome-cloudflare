const MELCLOUD_HOME = "https://melcloudhome.com";

function page(body, status = 200) {
  return new Response(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MELHome Bridge</title></head><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px">${body}</body></html>`,
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

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      // Start the AUTHENTIC MELCloud Home web login.
      // The browser is redirected to MELCloud's own BFF, which then
      // starts the OIDC/Cognito flow using MELCloud's registered client.
      if (request.method === "GET" && url.pathname === "/login") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${MELCLOUD_HOME}/bff/login`
          }
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        return page(`
          <h1>❄️ MELHome Bridge</h1>
          <p>Test de connexion avec le flux officiel MELCloud Home BFF.</p>
          <p>
            <a href="/login">
              <button style="padding:12px 22px;font-size:16px;cursor:pointer">
                🔐 Se connecter avec MELCloud
              </button>
            </a>
          </p>
          <hr>
          <p><b>Flux utilisé :</b></p>
          <pre>Worker → melcloudhome.com/bff/login → Cognito → MELCloud BFF</pre>
          <p style="color:#666;font-size:14px">
            Cette version est volontairement un test du flux officiel. Aucun identifiant,
            cookie ou token MELCloud n'est enregistré par ce Worker.
          </p>
        `);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({
          ok: true,
          service: "melhome-bridge-cloudflare",
          auth: "official-melcloud-bff"
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("[MELHOME]", error);
      return page(
        `<h1>❌ Erreur</h1><pre>${esc(error?.message || String(error))}</pre>`,
        500
      );
    }
  }
};