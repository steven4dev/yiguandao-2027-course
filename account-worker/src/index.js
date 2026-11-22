// 全真群島・帳號伺服器：LINE 登入＋把手機上的紀錄（徽章、籤冊、遊戲成績…）存一份在雲端
// 隱私原則：不存 LINE 名字、大頭照、email；LINE 的使用者代號先用祕密金鑰轉成匿名編號，伺服器只認這個編號。
import { mergeSnap, stripSnap, canon } from '../../islands/account-merge.js';

const LINE_AUTH = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY = 'https://api.line.me/oauth2/v2.1/verify';
const SESSION_DAYS = 180, STATE_MIN = 10, MAX_BODY = 200 * 1024;

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const rand = (n = 24) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function sign(secret, obj) { const body = b64u(enc.encode(JSON.stringify(obj))); const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)); return body + '.' + b64u(sig); }
async function unsign(secret, tok) {
  if (typeof tok !== 'string' || tok.length > 2000) return null; const [body, sig] = tok.split('.'); if (!body || !sig) return null;
  try { if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), enc.encode(body)))) return null; const o = JSON.parse(new TextDecoder().decode(unb64u(body))); return o && o.e > Date.now() ? o : null; } catch (e) { return null; }
}
const uidOf = async (env, sub) => b64u((await crypto.subtle.sign('HMAC', await hmacKey(env.UID_KEY), enc.encode('line:' + sub))).slice(0, 18));

const origins = (env) => (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// 登入完要回去的網址：只接受白名單網站，其他一律回群島首頁
function safeReturn(env, r) {
  const home = 'https://steven4dev.github.io/yiguandao-2027-course/islands/';
  try { const u = new URL(r); u.hash = ''; return origins(env).includes(u.origin) ? u.toString() : home; } catch (e) { return home; }
}
const cors = (req, env) => { const o = req.headers.get('Origin'); return o && origins(env).includes(o) ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin' } : {}; };
const json = (req, env, obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req, env) } });
const back = (url, frag) => new Response(null, { status: 302, headers: { Location: url + '#' + new URLSearchParams(frag).toString(), 'Cache-Control': 'no-store', 'Set-Cookie': 'acst=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax', 'Referrer-Policy': 'no-referrer' } });
const cookie = (req, name) => { const m = (req.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : ''; };

async function start(req, env, url) {
  const ret = safeReturn(env, url.searchParams.get('return') || ''), s = rand(16), nv = rand(16), cv = rand(32);
  const ch = b64u(await crypto.subtle.digest('SHA-256', enc.encode(cv)));
  // state 本身就是簽過名的小憑證（手機從 LINE App 切回瀏覽器時 cookie 可能不見，仍然能完成登入）；cookie 在的話再多比對一次
  const st = await sign(env.SESSION_KEY, { s, r: ret, nv, cv, e: Date.now() + STATE_MIN * 60e3 });
  const q = new URLSearchParams({ response_type: 'code', client_id: env.LINE_CHANNEL_ID, redirect_uri: env.PUBLIC_URL + '/auth/line/callback', state: st, scope: 'openid profile', nonce: nv, code_challenge: ch, code_challenge_method: 'S256' });
  return new Response(null, { status: 302, headers: { Location: LINE_AUTH + '?' + q, 'Cache-Control': 'no-store', 'Set-Cookie': `acst=${st}; Path=/auth; Max-Age=${STATE_MIN * 60}; HttpOnly; Secure; SameSite=Lax` } });
}

async function callback(req, env, url) {
  const qs = url.searchParams.get('state') || '', ck = cookie(req, 'acst'), st = await unsign(env.SESSION_KEY, qs), home = safeReturn(env, '');
  if (!st || (ck && ck !== qs)) return back(st ? st.r : home, { acct_err: 'expired' });   // 登入太久（超過 10 分鐘）或被偽造
  if (url.searchParams.get('error')) return back(st.r, { acct_err: url.searchParams.get('error') === 'access_denied' ? 'cancel' : 'line' });
  const code = url.searchParams.get('code'); if (!code) return back(st.r, { acct_err: 'line' });
  try {
    const tr = await fetch(LINE_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: env.PUBLIC_URL + '/auth/line/callback', client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET, code_verifier: st.cv }) });
    const tj = await tr.json(); if (!tr.ok || !tj.id_token) { console.log('token fail', tr.status, tj.error); return back(st.r, { acct_err: 'line' }); }
    const vr = await fetch(LINE_VERIFY, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id_token: tj.id_token, client_id: env.LINE_CHANNEL_ID, nonce: st.nv }) });
    const vj = await vr.json(); if (!vr.ok || !vj.sub) { console.log('verify fail', vr.status, vj.error); return back(st.r, { acct_err: 'line' }); }
    const u = await uidOf(env, vj.sub), t = await sign(env.SESSION_KEY, { u, e: Date.now() + SESSION_DAYS * 864e5 });
    // LINE 名字只放在網址的 # 後面交給手機顯示「已登入：○○」，伺服器不存
    return back(st.r, { acct: t, nm: String(vj.name || '').slice(0, 40) });
  } catch (e) { console.log('callback error', e && e.message); return back(st.r, { acct_err: 'line' }); }
}

// API 一律用 POST＋純文字內容（{t: 登入憑證, ...}），瀏覽器不用先送 CORS 預檢，離開頁面時的最後一次同步也送得出去
async function api(req, env, path) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req, env), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Max-Age': '86400' } });
  if (req.method !== 'POST') return json(req, env, { error: 'method' }, 405);
  const o = req.headers.get('Origin'); if (o && !origins(env).includes(o)) return json(req, env, { error: 'origin' }, 403);
  const raw = await req.text(); if (raw.length > MAX_BODY) return json(req, env, { error: 'too_big' }, 413);
  let body; try { body = JSON.parse(raw); } catch (e) { return json(req, env, { error: 'bad_json' }, 400); }
  const s = await unsign(env.SESSION_KEY, body && body.t); if (!s || !s.u) return json(req, env, { error: 'auth' }, 401);
  const stub = env.VAULT.get(env.VAULT.idFromName(s.u));
  const r = await stub.fetch('https://vault/' + path, { method: 'POST', body: JSON.stringify({ data: body.data }) });
  return json(req, env, await r.json(), r.status);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/auth/line/start') return start(req, env, url);
    if (p === '/auth/line/callback') return callback(req, env, url);
    if (p === '/api/sync') return api(req, env, 'sync');
    if (p === '/api/delete') return api(req, env, 'delete');
    if (p === '/health') return json(req, env, { ok: true, line: !!env.LINE_CHANNEL_SECRET, keys: !!(env.SESSION_KEY && env.UID_KEY) });
    return new Response('全真群島帳號伺服器', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

// 一個帳號＝一個 Durable Object，裡面只存一份合併後的紀錄快照
export class Vault {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(req) {
    const path = new URL(req.url).pathname.slice(1), { data } = await req.json();
    if (path === 'delete') { await this.ctx.storage.deleteAll(); return Response.json({ ok: true, deleted: true }); }
    const cur = (await this.ctx.storage.get('snap')) || { data: {}, created: Date.now(), updated: 0 };
    const merged = mergeSnap(cur.data, stripSnap(data));
    if (canon(merged) !== canon(cur.data)) {
      if (JSON.stringify(merged).length > MAX_BODY) return Response.json({ error: 'too_big' }, { status: 413 });
      cur.data = merged; cur.updated = Date.now(); await this.ctx.storage.put('snap', cur);
    }
    return Response.json({ ok: true, data: cur.data, updated: cur.updated, created: cur.created });
  }
}
