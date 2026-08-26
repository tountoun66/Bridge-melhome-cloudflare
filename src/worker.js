const AUTH_BASE = "https://auth.melcloudhome.com";
const TOKEN_URL = `${AUTH_BASE}/connect/token`;
const PAR_URL = `${AUTH_BASE}/connect/par`;
const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;
const CLIENT_ID = "homemobile";
const REDIRECT_URI = "melcloudhome://";
const SCOPES = "openid profile email offline_access IdentityServerApi";
const USER_AGENT = "MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0";

const html = (body, status = 200) => new Response(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:20px">${body}</body></html>`, { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const b64url = bytes => { let s=""; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); };

async function getOAuth(env) { return env.DB.prepare("SELECT * FROM oauth_tokens ORDER BY updated_at DESC LIMIT 1").first(); }
async function saveOAuth(env, t) {
  if (!t?.refresh_token) throw new Error("MELCloud n'a pas fourni de refresh_token");
  const now = Date.now();
  const expires = t.expires_at || now + Number(t.expires_in || 3600) * 1000;
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("INSERT INTO oauth_tokens(id,access_token,refresh_token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), t.access_token || null, t.refresh_token, expires, now, now).run();
}
async function refresh(env, row) {
  if (!row?.refresh_token) throw new Error("Aucun refresh_token MELCloud enregistré");
  const r = await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json","User-Agent":USER_AGENT},body:new URLSearchParams({grant_type:"refresh_token",client_id:CLIENT_ID,refresh_token:row.refresh_token})});
  const text = await r.text();
  if (!r.ok) throw new Error(`Refresh MELCloud HTTP ${r.status}: ${text.slice(0,200)}`);
  const t = JSON.parse(text); if(!t.refresh_token)t.refresh_token=row.refresh_token; await saveOAuth(env,t); return t.access_token;
}
function addCookies(jar, response) {
  let list=[];
  try { if(typeof response.headers.getSetCookie === "function") list=response.headers.getSetCookie(); } catch {}
  if(!list.length){ const raw=response.headers.get("set-cookie"); if(raw) list=raw.split(/,(?=\s*[^;,=\s]+=[^;,]+)/); }
  for(const v of list){ const p=v.split(";",1)[0], i=p.indexOf("="); if(i>0)jar.set(p.slice(0,i).trim(),p.slice(i+1).trim()); }
}
const cookies = jar => [...jar].map(([k,v])=>`${k}=${v}`).join("; ");
const codeFrom = s => { const m=String(s||"").match(/[?&]code=([^&\s"'<>]+)/i); return m?decodeURIComponent(m[1]):null; };
const csrfFrom = s => { const a=String(s||"").match(/name=["']_csrf["'][^>]*value=["']([^"']+)["']/i)||String(s||"").match(/value=["']([^"']+)["'][^>]*name=["']_csrf["']/i); return a?.[1]||null; };
function formFromHtml(body, base) {
  const m=String(body||"").match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i); if(!m)return null;
  const action=new URL(m[1],base).toString(), data=new URLSearchParams();
  for(const x of m[2].matchAll(/<input[^>]*>/gi)){ const tag=x[0], n=tag.match(/name=["']([^"']+)["']/i)?.[1], v=tag.match(/value=["']([^"']*)["']/i)?.[1]??""; if(n)data.set(n,v); }
  return {action,data};
}
async function request(url, init, jar) {
  const h=new Headers(init?.headers||{}); const c=cookies(jar); if(c)h.set("Cookie",c);
  const r=await fetch(url,{...init,headers:h,redirect:"manual"}); addCookies(jar,r); return r;
}
async function follow(startUrl, jar, max=20) {
  let url=startUrl, init={method:"GET",headers:{"User-Agent":USER_AGENT,Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}};
  for(let i=0;i<max;i++){
    const r=await request(url,init,jar), location=r.headers.get("location");
    if(location){ const next=new URL(location,url).toString(); if(/^melcloudhome:\/\//i.test(next)) return {url:next,response:r}; url=next; init={method:"GET",headers:{"User-Agent":USER_AGENT,Accept:"text/html,application/xhtml+xml"}}; continue; }
    const body=await r.text(), c=codeFrom(url)||codeFrom(body); if(c)return {url:`${url}${url.includes("?")?"&":"?"}code=${encodeURIComponent(c)}`,response:r,body};
    const f=formFromHtml(body,url); if(f && (/signin-oidc-meu|authorize\/callback|ExternalLogin\/Callback/i.test(f.action) || /\bcode\b/i.test(body))){ url=f.action; init={method:"POST",headers:{"User-Agent":USER_AGENT,"Content-Type":"application/x-www-form-urlencoded",Referer:url},body:f.data.toString()}; continue; }
    return {url,response:r,body};
  }
  throw new Error("Trop de redirections MELCloud");
}
async function loginToMelcloud(email,password){
  const jar=new Map(), verifier=b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier));
  const challenge=b64url(new Uint8Array(digest)), state=b64url(crypto.getRandomValues(new Uint8Array(16)));
  const par=await fetch(PAR_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json","User-Agent":USER_AGENT},body:new URLSearchParams({response_type:"code",state,code_challenge:challenge,code_challenge_method:"S256",client_id:CLIENT_ID,scope:SCOPES,redirect_uri:REDIRECT_URI})});
  const ptxt=await par.text(); if(par.status!==201)throw new Error(`MELCloud PAR HTTP ${par.status}: ${ptxt.slice(0,250)}`);
  const pdata=JSON.parse(ptxt); if(!pdata.request_uri)throw new Error("MELCloud n'a pas fourni de request_uri");
  const auth=`${AUTHORIZE_URL}?client_id=${encodeURIComponent(CLIENT_ID)}&request_uri=${encodeURIComponent(pdata.request_uri)}`;
  let first=await follow(auth,jar), host=""; try{host=new URL(first.url).hostname||"";}catch{}
  if(!codeFrom(first.url) && host.includes("amazoncognito.com")){
    const body=first.body ?? await first.response.text(), csrf=csrfFrom(body); if(!csrf)throw new Error("Impossible de récupérer le CSRF Cognito");
    const login=await request(first.url,{method:"POST",headers:{"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76","Content-Type":"application/x-www-form-urlencoded",Origin:`https://${host}`,Referer:first.url,Accept:"text/html,application/xhtml+xml"},body:new URLSearchParams({_csrf:csrf,username:email,password,cognitoAsfData:""}).toString()},jar);
    const loc=login.headers.get("location"); if(loc) first=await follow(new URL(loc,first.url).toString(),jar); else { const body2=await login.text(), f=formFromHtml(body2,first.url); if(f)first=await follow(f.action,jar); else { const c=codeFrom(body2); if(c)first={url:`${REDIRECT_URI}?code=${encodeURIComponent(c)}`}; } }
  }
  const authCode=codeFrom(first.url)||codeFrom(first.body); if(!authCode)throw new Error("MELCloud n'a pas renvoyé de code OAuth. Le flux Cognito a changé ou la connexion a été refusée.");
  const tr=await fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json","User-Agent":USER_AGENT},body:new URLSearchParams({grant_type:"authorization_code",code:authCode,redirect_uri:REDIRECT_URI,code_verifier:verifier,client_id:CLIENT_ID})});
  const ttxt=await tr.text(); if(!tr.ok)throw new Error(`Échange OAuth HTTP ${tr.status}: ${ttxt.slice(0,300)}`);
  const tokens=JSON.parse(ttxt); if(!tokens.refresh_token)throw new Error("MELCloud n'a pas fourni de refresh_token"); return tokens;
}
export default { async fetch(request,env){
  const u=new URL(request.url);
  try{
    if(request.method==="GET"&&u.pathname==="/"){const o=await getOAuth(env);return html(`<h1>❄️ MELHome OAuth</h1><p>Token MELCloud : <b>${o?.refresh_token?"ENREGISTRÉ":"ABSENT"}</b></p><p><a href="/setup">Connexion MELCloud</a></p><p><a href="/api/status">État OAuth</a></p>`);}
    if(request.method==="GET"&&u.pathname==="/health")return Response.json({ok:true,service:"melhome-oauth",client_id:CLIENT_ID});
    if(request.method==="GET"&&u.pathname==="/api/status"){const o=await getOAuth(env);return Response.json({ok:true,authenticated:!!o?.refresh_token,expires_at:o?.expires_at??null,has_refresh_token:!!o?.refresh_token});}
    if(request.method==="GET"&&u.pathname==="/setup"){const o=await getOAuth(env);return html(`<h1>🔐 Connexion MELCloud</h1><p>État : <b>${o?.refresh_token?"TOKEN ENREGISTRÉ":"NON CONNECTÉ"}</b></p><form method="post"><input name="email" type="email" autocomplete="username" placeholder="E-mail" required style="width:100%;padding:10px"><br><br><input name="password" type="password" autocomplete="current-password" placeholder="Mot de passe" required style="width:100%;padding:10px"><br><br><button style="padding:12px 20px">Se connecter</button></form><p style="font-size:13px;color:#666">Le mot de passe sert uniquement pendant cette tentative et n'est pas enregistré dans D1.</p>`);}
    if(request.method==="POST"&&u.pathname==="/setup"){const f=await request.formData(),email=String(f.get("email")||"").trim(),password=String(f.get("password")||"");if(!email||!password)return html("Identifiants manquants",400);try{const t=await loginToMelcloud(email,password);await saveOAuth(env,t);return html("<h1>✅ Token MELCloud récupéré</h1><p>Le refresh_token est enregistré dans D1.</p><p><a href='/api/status'>Vérifier</a></p>");}catch(e){return html(`<h1>❌ Connexion MELCloud impossible</h1><pre>${esc(e?.message||e)}</pre><p><a href='/setup'>Réessayer</a></p>`,400);}}
    if(request.method==="POST"&&u.pathname==="/api/refresh"){const o=await getOAuth(env);const access=await refresh(env,o);return Response.json({ok:true,access_token_saved:!!access});}
    return new Response("Not found",{status:404});
  }catch(e){console.error("[MELHOME]",e);return Response.json({ok:false,error:e?.message||String(e)},{status:500});}
} };