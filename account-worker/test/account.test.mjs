// 帳號伺服器測試：node test/account.test.mjs（先 npx wrangler dev --port 8788 --local，.dev.vars 的 SESSION_KEY 要跟下面一樣）
import { webcrypto as crypto } from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:8788', KEY = process.env.SESSION_KEY || 'test-session-key-local', ORIGIN = 'http://localhost:8765';
const enc = new TextEncoder(), b64u = (b) => Buffer.from(b).toString('base64url');
async function sign(obj) { const body = b64u(enc.encode(JSON.stringify(obj))); const k = await crypto.subtle.importKey('raw', enc.encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return body + '.' + b64u(await crypto.subtle.sign('HMAC', k, enc.encode(body))); }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + m); };
const post = async (p, body, origin = ORIGIN) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: origin }, body: typeof body === 'string' ? body : JSON.stringify(body) }); let j = {}; try { j = await r.json(); } catch (e) {} return { s: r.status, j, h: r.headers }; };

// 登入跳轉
let r = await fetch(BASE + '/auth/line/start?return=' + encodeURIComponent(ORIGIN + '/islands/index.html?x=1#old'), { redirect: 'manual' });
const loc = new URL(r.headers.get('location')); ok(loc.origin === 'https://access.line.me' && loc.searchParams.get('scope') === 'openid profile' && loc.searchParams.get('code_challenge_method') === 'S256' && loc.searchParams.get('client_id') === '2012742687', '登入跳到 LINE（openid profile、PKCE、Channel ID）');
const state = loc.searchParams.get('state'), ck = (r.headers.get('set-cookie') || '').match(/acst=([^;]+)/)[1]; ok(ck === state, 'state 也放在 cookie');
r = await fetch(BASE + '/auth/line/start?return=https://evil.example/x', { redirect: 'manual' }); ok(new URL(r.headers.get('location')).searchParams.get('state') && JSON.parse(Buffer.from(new URL(r.headers.get('location')).searchParams.get('state').split('.')[0], 'base64url')).r.startsWith('https://steven4dev.github.io/'), '白名單外的回跳網址改回群島首頁');
// callback：取消、偽造、過期
r = await fetch(BASE + '/auth/line/callback?error=access_denied&state=' + encodeURIComponent(state), { redirect: 'manual' }); ok(r.status === 302 && r.headers.get('location') === ORIGIN + '/islands/index.html?x=1#acct_err=cancel', '使用者取消 → 回原頁 #acct_err=cancel（# 舊內容清掉）');
r = await fetch(BASE + '/auth/line/callback?code=x&state=' + encodeURIComponent(state.slice(0, -3) + 'abc'), { redirect: 'manual' }); ok(/#acct_err=expired$/.test(r.headers.get('location')), '偽造 state → expired');
r = await fetch(BASE + '/auth/line/callback?code=x&state=' + encodeURIComponent(state), { redirect: 'manual', headers: { Cookie: 'acst=other' } }); ok(/#acct_err=expired$/.test(r.headers.get('location')), 'cookie 和 state 不一致 → expired');
r = await fetch(BASE + '/auth/line/callback?code=fake&state=' + encodeURIComponent(state), { redirect: 'manual' }); ok(/#acct_err=line$/.test(r.headers.get('location')), '假的 code（LINE 拒絕）→ #acct_err=line');

// API
const tA = await sign({ u: 'userA-' + Date.now(), e: Date.now() + 3600e3 }), tB = await sign({ u: 'userB-' + Date.now(), e: Date.now() + 3600e3 });
ok((await post('/api/sync', { t: 'bad.token', data: {} })).s === 401, '假憑證 → 401');
ok((await post('/api/sync', { t: await sign({ u: 'x', e: Date.now() - 1 }), data: {} })).s === 401, '過期憑證 → 401');
ok((await post('/api/sync', { t: tA, data: {} }, 'https://evil.example')).s === 403, '其他網站來源 → 403');
ok((await post('/api/sync', 'not json')).s === 400, '壞 JSON → 400');
ok((await post('/api/sync', { t: tA, data: { pad: 'x'.repeat(1100 * 1024) } })).s === 413, '超過 1MB → 413');
const phone1 = { 'islands-badges': { v: 1, got: { a: 300, b: 200 }, seen: { isle: ['x'] }, days: ['2026-11-20'], fresh: { a: 1 } }, 'islands-jishi': { v: 2, day: '2026-11-20', today: 5, got: { 5: '2026-11-20' } },
  'islands-chef': { v: 1, name: '小廚', best: { tofu: 70 }, issue: 2, covers: ['data:image/jpeg;base64,AAAA'] }, 'fuchenGame.best': 1200, 'fuchenGame.dex': { v: 1, m: { 灰塵: { n: 3, first: '2026/11/20' } } }, 'islands-mybottles': [{ ts: 1, text: 'hi' }], 'islands-sky': 'night', junk: 1 };
r = await post('/api/sync', { t: tA, data: phone1 }); ok(r.s === 200 && r.h.get('access-control-allow-origin') === ORIGIN, '第一次同步 200（CORS 允許群島網頁）');
ok(r.j.data['islands-chef'].covers.length === 0 && !('islands-sky' in r.j.data) && !('junk' in r.j.data), '封面圖片、不在同步清單的設定不上傳');
const phone2 = { 'islands-badges': { v: 1, got: { a: 100, c: 400 }, seen: { isle: ['y'] }, days: ['2026-11-22'] }, 'islands-jishi': { v: 2, day: '2026-11-22', today: 9, got: { 9: '2026-11-22', 5: '2026-11-21' } },
  'islands-chef': { v: 1, name: '', best: { tofu: 90, soup: 40 }, issue: 1, covers: [] }, 'fuchenGame.best': 900, 'fuchenGame.dex': { v: 1, m: { 灰塵: { n: 5, first: '2026/11/22', gold: true }, 霧魔: { n: 1, first: '2026/11/22' } } }, 'islands-mybottles': [{ ts: 2, text: 'yo' }, { ts: 1, text: 'hi' }], 'islands-puti': { v: 9 } };
r = await post('/api/sync', { t: tA, data: phone2 }); const d = r.j.data;
ok(d['islands-badges'].got.a === 100 && d['islands-badges'].got.b === 200 && d['islands-badges'].got.c === 400, '徽章聯集、解鎖時間取早的');
ok(d['islands-badges'].seen.isle.length === 2 && d['islands-badges'].days.join() === '2026-11-20,2026-11-22', '逛過的地方、上島日子合併');
ok(d['islands-jishi'].today === 9 && d['islands-jishi'].got[5] === '2026-11-20' && d['islands-jishi'].got[9], '籤冊聯集、今天的籤取較新的一天');
ok(d['islands-chef'].name === '小廚' && d['islands-chef'].best.tofu === 90 && d['islands-chef'].best.soup === 40 && d['islands-chef'].issue === 2, '廚神：名字保留、最高分取高、期數取大');
ok(d['fuchenGame.best'] === 1200 && d['fuchenGame.dex'].m['灰塵'].n === 5 && d['fuchenGame.dex'].m['灰塵'].gold && d['fuchenGame.dex'].m['灰塵'].first === '2026/11/20' && d['fuchenGame.dex'].m['霧魔'], '拂塵：最高分取高、圖鑑合併');
ok(d['islands-mybottles'].length === 2 && !('islands-puti' in d), '瓶中信去重；格式不對的紀錄（puti v9）不收');
r = await post('/api/sync', { t: tB, data: {} }); ok(r.s === 200 && Object.keys(r.j.data).length === 0, '另一個帳號看不到 A 的紀錄');
r = await post('/api/delete', { t: tA }); ok(r.j.deleted, '刪除雲端紀錄');
r = await post('/api/sync', { t: tA, data: {} }); ok(Object.keys(r.j.data).length === 0, '刪除後雲端是空的');

// 配對碼
const tC = await sign({ u: 'userC-' + Date.now(), e: Date.now() + 3600e3 });
ok((await post('/api/pair/create', { t: 'bad.token' })).s === 401, '配對碼：假憑證不能產生');
r = await post('/api/pair/create', { t: tC, nm: '小明' }); const code = r.j.code; ok(r.s === 200 && /^\d{8}$/.test(code) && r.j.exp > Date.now(), '產生 8 位數配對碼（5 分鐘內有效）');
await post('/api/sync', { t: tC, data: { 'fuchenGame.best': 777 } });
r = await post('/api/pair/redeem', { code: code.slice(0, 4) + ' ' + code.slice(4) }); ok(r.s === 200 && r.j.t && r.j.nm === '小明', '另一個裝置輸入代碼（含空格）→ 拿到新憑證和名字');
r = await post('/api/sync', { t: r.j.t, data: {} }); ok(r.j.data['fuchenGame.best'] === 777, '新裝置的憑證讀得到同一個帳號的紀錄');
r = await post('/api/pair/redeem', { code }); ok(r.s === 404, '代碼只能用一次');
ok((await post('/api/pair/redeem', { code: '12ab' })).s === 400, '格式不對 → 400');
ok((await post('/api/pair/redeem', { code }, 'https://evil.example')).s === 403, '其他網站來源 → 403');
let hit429 = false; for (let i = 0; i < 14; i++) { const x = await post('/api/pair/redeem', { code: String(10000000 + i * 7919) }); if (x.s === 429) { hit429 = true; break; } }
ok(hit429, '亂猜代碼：同一個 IP 10 分鐘試 10 次後被擋（429）');
// 投壺島：兩支手機各自的紀錄取較大值；暱稱、操作方式、左右對調不上傳
const tD = await sign({ u: 'userD-' + Date.now(), e: Date.now() + 3600e3 });
r = await post('/api/sync', { t: tD, data: { 'islands-touhu': { v: 1, best: 21.5, plays: 3, ins: 20, ears: 4, throws: 36, mode: 'touch', nick: '暱稱', nickCustom: true, flipX: true } } });
ok(r.s === 200 && r.j.data['islands-touhu'].best === 21.5 && r.j.data['islands-touhu'].plays === 3, '投壺島：第一支手機的紀錄上傳成功');
ok(!('nick' in r.j.data['islands-touhu']) && !('mode' in r.j.data['islands-touhu']) && !('flipX' in r.j.data['islands-touhu']) && !('nickCustom' in r.j.data['islands-touhu']), '投壺島：暱稱、操作方式、左右對調只留在手機');
r = await post('/api/sync', { t: tD, data: { 'islands-touhu': { v: 1, best: 18, plays: 7, ins: 12, ears: 9, throws: 50 } } });
const th = r.j.data['islands-touhu']; ok(th.best === 21.5 && th.plays === 7 && th.ins === 20 && th.ears === 9 && th.throws === 50, '投壺島：另一支手機同步後，每一項取較大值（最高分 21.5、場次 7、入壺 20、貫耳 9、投矢 50）');
ok((await post('/api/sync', { t: tD, data: { 'islands-touhu': { v: 2, best: 99 } } })).j.data['islands-touhu'].best === 21.5, '投壺島：格式看不懂的那一份丟掉，不蓋壞好的紀錄');
console.log(`\n${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
