/**
 * Beach Math — Cloudflare Worker (static assets + API)
 * Serves the site from /public and handles the API routes:
 *   POST /api/login   { code }     -> sets a signed session cookie, returns { id, name }
 *   GET  /api/me                   -> { id, name } if the cookie is valid, else 401
 *   POST /api/logout               -> clears the cookie
 *   POST /api/log     { ...event } -> verifies cookie, forwards a row to the Google Sheet
 *   GET  /api/load                 -> returns this user's progress from KV
 *   POST /api/save    { progress } -> saves this user's progress to KV (cross-device sync)
 *
 * Set in the dashboard (Worker -> Settings -> Variables and Secrets), all as Secret:
 *   USERS_JSON    {"beachfc":{"id":"madeleine","name":"Madeleine"},"test":{"id":"test","name":"Test"}}
 *   TOKEN_SECRET  a long random string
 *   SHEET_URL     your Apps Script Web App URL ending in /exec
 * KV + assets bindings come from wrangler.jsonc (BEACH_MATH_KV, ASSETS).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_DAYS = 120;

function b64urlBytes(bytes) { let s = btoa(String.fromCharCode(...bytes)); return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function bytesFromB64url(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; const bin = atob(str); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
const b64url = (str) => b64urlBytes(enc.encode(str));
const unb64url = (str) => dec.decode(bytesFromB64url(str));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return body + "." + b64urlBytes(sig);
}
async function verify(token, secret) {
  if (!token || token.indexOf(".") === -1) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(secret);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(sig), enc.encode(body)); } catch (e) { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(unb64url(body)); } catch (e) { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

function readCookie(name, request) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const cookieFor = (token) =>
  `bm_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}`;
const clearCookie = "bm_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

async function handleApi(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const SECRET = env.TOKEN_SECRET || "change-me-in-env";
  let USERS = {};
  try { USERS = JSON.parse(env.USERS_JSON || "{}"); } catch (e) { USERS = {}; }

  if (path === "/api/login" && request.method === "POST") {
    let code = "";
    try { const b = await request.json(); code = String(b.code || "").trim().toLowerCase(); } catch (e) {}
    const u = USERS[code];
    if (!u) return json({ error: "bad code" }, 401);
    const token = await sign({ id: u.id, name: u.name, exp: Date.now() + 1000 * 60 * 60 * 24 * SESSION_DAYS }, SECRET);
    return json({ id: u.id, name: u.name }, 200, { "Set-Cookie": cookieFor(token) });
  }

  if (path === "/api/me" && request.method === "GET") {
    const p = await verify(readCookie("bm_session", request), SECRET);
    if (!p) return json({ error: "no session" }, 401);
    return json({ id: p.id, name: p.name });
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
  }

  if (path === "/api/log" && request.method === "POST") {
    const p = await verify(readCookie("bm_session", request), SECRET);
    if (!p) return json({ error: "no session" }, 401);
    if (!env.SHEET_URL) return json({ ok: true, note: "no sheet configured" });
    let b = {};
    try { b = await request.json(); } catch (e) {}
    const row = {
      ts: new Date().toISOString(),
      name: p.name,
      mode: b.mode || "", unit: b.unit || "", topic: b.topic || "",
      correct: b.correct, given: b.given || "", answer: b.answer || "",
      xp: b.xp, streak: b.streak, level: b.level,
    };
    try {
      await fetch(env.SHEET_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(row) });
    } catch (e) {}
    return json({ ok: true });
  }

  if (path === "/api/load" && request.method === "GET") {
    const p = await verify(readCookie("bm_session", request), SECRET);
    if (!p) return json({ error: "no session" }, 401);
    if (!env.BEACH_MATH_KV) return json({ progress: null, note: "no kv bound" });
    const raw = await env.BEACH_MATH_KV.get("progress:" + p.id);
    let prog = null;
    if (raw) { try { prog = JSON.parse(raw); } catch (e) {} }
    return json({ progress: prog });
  }

  if (path === "/api/save" && request.method === "POST") {
    const p = await verify(readCookie("bm_session", request), SECRET);
    if (!p) return json({ error: "no session" }, 401);
    if (!env.BEACH_MATH_KV) return json({ ok: true, note: "no kv bound" });
    let b = {};
    try { b = await request.json(); } catch (e) {}
    if (b.progress) await env.BEACH_MATH_KV.put("progress:" + p.id, JSON.stringify(b.progress));
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    // everything else: serve the static site from /public
    return env.ASSETS.fetch(request);
  },
};
