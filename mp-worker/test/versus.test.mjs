// 用 `npx wrangler dev --port 8787` 啟動後執行：node test/versus.test.mjs
import WebSocket from 'ws';
// 在有 HTTPS 代理的環境（例如雲端開發機）測線上版：WebSocket 也要走代理
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const wsAgent = PROXY && !/localhost|127\.0\.0\.1/.test(process.env.BASE || 'localhost') ? new (await import('https-proxy-agent')).HttpsProxyAgent(PROXY) : undefined;
const BASE = process.env.BASE || 'http://localhost:8787', WS = BASE.replace(/^http/, 'ws'), ORIGIN = 'http://localhost:8765';
let fail = 0; const ok = (c, msg) => { console.log((c ? '  ✅ ' : '  ❌ ') + msg); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(code, name) {
  const c = { msgs: [], state: null, pid: null, fx: [], errors: [] };
  c.ws = new WebSocket(`${WS}/api/room/${code}/ws`, { headers: { Origin: ORIGIN }, agent: wsAgent });
  c.ready = new Promise((res, rej) => { c.ws.on('open', res); c.ws.on('error', rej); });
  c.ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'state') c.state = m; if (m.t === 'welcome') c.pid = m.pid; if (m.t === 'fx') c.fx.push(m); if (m.t === 'error') c.errors.push(m.code); });
  c.send = o => c.ws.send(JSON.stringify(o));
  c.until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (c.state && fn(c.state)) return true; await sleep(30); } return false; };
  return c;
}
const api = async (path, opt) => { const r = await fetch(BASE + path, { ...opt, headers: { Origin: ORIGIN, ...(opt && opt.headers) } }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };

console.log('① 建立房間');
const cr = await api('/api/create', { method: 'POST' }); const code = cr.body && cr.body.code;
ok(cr.status === 200 && /^[A-HJ-NP-Z2-9]{5}$/.test(code), `房號 ${code}（5 碼、沒有 I O 0 1）`);
ok(cr.headers.get('access-control-allow-origin') === ORIGIN, '允許的來源有 CORS 標頭');
const bad = await fetch(BASE + '/api/create', { method: 'POST', headers: { Origin: 'https://evil.example' } }); ok(bad.headers.get('access-control-allow-origin') === 'null', '陌生來源不給 CORS');
ok((await api(`/api/room/${code.toLowerCase()}`)).body.exists === true, '小寫房號也找得到');
ok((await api('/api/room/ZZZZZ')).status === 404, '不存在的房號回 404');

console.log('② 兩人加入');
const A = client(code, 'A'); await A.ready; A.send({ t: 'join', name: '甲', avatar: 'se' }); await A.until(s => s.you === 0);
ok(A.pid && A.state.you === 0 && A.state.host === 0, '甲進房，是 P1 也是房主');
const B = client(code, 'B'); await B.ready; B.send({ t: 'join', name: '乙', avatar: 'fa' }); await B.until(s => s.you === 1);
ok(B.state.you === 1 && B.state.players[0].name === '甲', '乙進房，看得到甲');
ok(A.state.players[1] && A.state.players[1].name === '乙', '甲也即時看到乙');
const C = client(code, 'C'); await C.ready; C.send({ t: 'join', name: '丙' }); await sleep(300); ok(C.errors.includes('full'), '第三個人被擋下（房間已滿）');
ok(!JSON.stringify(A.msgs).includes(B.pid), '甲的訊息裡沒有乙的通行碼');

console.log('②b 觀戰（投影用）');
const W = client(code, 'W'); await W.ready; W.send({ t: 'join', watch: true }); await W.until(s => s.you === -1);
ok(W.state && W.state.you === -1 && W.state.players[0].name === '甲' && W.state.players[1].name === '乙', '觀戰者看得到兩位玩家、自己不佔位置');
ok(W.msgs.some(m => m.t === 'welcome' && m.watch), '觀戰者收到 welcome（watch）');
W.send({ t: 'ready', ready: true }); W.send({ t: 'set', diff: 'hard' }); await sleep(250); ok(A.state.diff === 'easy' && !A.state.players.some(p => p && p.ready), '觀戰者不能準備、不能改難度');
const Ws = []; for (let i = 0; i < 8; i++) { const x = client(code, 'w' + i); await x.ready; x.send({ t: 'join', watch: true }); Ws.push(x); } await sleep(500);
ok(Ws[7].errors.includes('watch_full') && !Ws[6].errors.length, '觀戰最多 8 個，第 9 個被擋');
for (const x of Ws) x.ws.close(); await sleep(300);
console.log('③ 房主換難度、準備、開打');
B.send({ t: 'set', diff: 'hard' }); await sleep(200); ok(A.state.diff === 'easy', '非房主不能改難度');
A.send({ t: 'set', diff: 'normal' }); await A.until(s => s.diff === 'normal'); ok(A.state.diff === 'normal' && B.state.diff === 'normal', '房主改難度，雙方都同步');
A.send({ t: 'ready', ready: true }); await sleep(200); ok(A.state.phase === 'lobby', '只有一人準備，還不開打');
B.send({ t: 'ready', ready: true }); await A.until(s => s.phase === 'playing'); await B.until(s => s.phase === 'playing');
ok(A.state.seed === B.state.seed && A.state.seed > 0, `雙方拿到同一個種子 ${A.state.seed}`);
ok(A.state.startAt - A.state.now > 3000 && A.state.startAt === B.state.startAt, '倒數開始時間一致（約 4.5 秒後）');

console.log('④ 時間同步（ping/pong）');
A.send({ t: 'ping', c: 7 }); await sleep(150); const pong = A.msgs.find(m => m.t === 'pong'); ok(pong && pong.c === 7 && Math.abs(pong.s - Date.now()) < 2000, '伺服器時間回得來');

console.log('⑤ 對戰事件');
await sleep(A.state.startAt - Date.now() + 600);
A.send({ t: 'cur', n: 2 }); A.send({ t: 'path', paths: [[[0, 0], [50, 50], [999, -999]], null, 'x', 'y'], ok: [true, false], why: ['', '動作太小很長很長很長很長很長'] }); A.send({ t: 'ev', ok: true, stage: 2, multi: true, fam: 'xiang', score: 160, lives: 3, hits: 1, combo: 1 });
await B.until(s => s.players[0].score === 160); ok(B.state.players[0].score === 160 && B.state.players[0].last === '連擊淨化', '乙看到甲的分數與動作');
await sleep(150); ok(B.fx.length === 1 && B.fx[0].fam === 'xiang' && B.fx[0].from === 0, '甲打中塵妖連擊 → 乙收到「干擾」（香系）');
ok(A.fx.length === 0, '干擾只送給對手，不回送自己');
A.send({ t: 'ev', ok: true, stage: 1, multi: false, fam: 'se', score: 99999, lives: 3, hits: 2, combo: 1 }); await sleep(200); ok(A.state.players[0].score <= 160 + 600, '單次加分有上限（防亂報分）');
A.send({ t: 'ev', ok: false, stage: 1, score: 10, lives: 3, hits: 2, combo: 1 }); await sleep(200); ok(A.state.players[0].score >= 160, '分數不會倒退');
B.send({ t: 'ev', ok: false, stage: 1, score: 0, lives: 2, hits: 0, combo: 0 }); await sleep(120); B.send({ t: 'ev', ok: false, stage: 1, score: 0, lives: 1, hits: 0, combo: 0 }); await sleep(120);
B.send({ t: 'ev', ok: false, stage: 1, score: 0, lives: 0, hits: 0, combo: 0 }); await A.until(s => s.phase === 'done');
ok(A.state.phase === 'done' && A.state.result.winner === 0 && A.state.result.reason === 'knockout', '乙心燈用完 → 甲獲勝（knockout）');
ok(B.state.result && B.state.result.players[0].score === A.state.players[0].score, '雙方看到相同的結算');

ok(W.msgs.some(m => m.t === 'evx' && m.slot === 0 && m.ok) && W.msgs.some(m => m.t === 'evx' && m.slot === 1 && !m.ok), '觀戰者收到雙方的打中／失敗事件');
ok(W.msgs.some(m => m.t === 'fx' && m.from === 0), '觀戰者也看到干擾');
{ const pm = W.msgs.find(m => m.t === 'path'); ok(pm && pm.slot === 0 && pm.paths.length === 3 && pm.paths[0][2][0] === 150 && pm.paths[0][2][1] === -150 && pm.paths[1] === null && pm.why[1].length <= 12, '觀戰者收到揮舞路徑（格式被清理、數值被限制）'); }
ok(!A.msgs.some(m => m.t === 'path') && !B.msgs.some(m => m.t === 'path'), '路徑只給觀戰者，不送給玩家');
ok(W.msgs.some(m => m.t === 'evx' && m.slot === 1 && m.lives === 0), '觀戰者知道對方最後一盞心燈熄了（加重爪痕用）');
ok(W.msgs.some(m => m.t === 'cur' && m.slot === 0 && m.n === 2), '觀戰者收到「甲開始打第 3 隻」');
ok(W.state.phase === 'done' && W.state.result.winner === 0, '觀戰者看到結算');
console.log('⑥ 再來一局');
A.send({ t: 'rematch' }); await A.until(s => s.phase === 'lobby'); ok(A.state.phase === 'lobby' && A.state.players[0].ready === false && A.state.players[0].lives === 3, '回到大廳、準備與心燈重置');

console.log('⑦ 斷線重連');
B.ws.close(); await sleep(400); ok(A.state.players[1] && A.state.players[1].online === false, '乙斷線，甲看到「離線」');
const B2 = client(code, 'B2'); await B2.ready; B2.send({ t: 'join', pid: B.pid }); await B2.until(s => s.you === 1);
ok(B2.state.you === 1 && B2.state.players[1].name === '乙', '乙用通行碼重連，拿回原本位置');
await A.until(s => s.players[1] && s.players[1].online === true); ok(A.state.players[1].online === true, '甲看到乙回來了');

console.log('⑧ 對戰中離場 = 判輸');
A.send({ t: 'ready', ready: true }); B2.send({ t: 'ready', ready: true }); await A.until(s => s.phase === 'playing'); await sleep(A.state.startAt - Date.now() + 300);
B2.send({ t: 'leave' }); await A.until(s => s.phase === 'done'); ok(A.state.result.winner === 0 && A.state.result.reason === 'forfeit', '乙中途離開 → 甲獲勝（forfeit）');

console.log('⑧b 時間到結算（測試環境把對戰縮成 5 秒）');
A.send({ t: 'rematch' }); await A.until(s => s.phase === 'lobby'); const E = client(code, 'E'); await E.ready; E.send({ t: 'join', name: '戊' }); await E.until(s => s.you === 1);
A.send({ t: 'ready', ready: true }); E.send({ t: 'ready', ready: true }); await A.until(s => s.phase === 'playing'); await sleep(A.state.startAt - Date.now() + 300);
A.send({ t: 'ev', ok: true, stage: 1, multi: false, fam: 'se', score: 100, lives: 3, hits: 1, combo: 1 }); E.send({ t: 'ev', ok: true, stage: 1, multi: false, fam: 'se', score: 60, lives: 3, hits: 1, combo: 1 });
await sleep(Math.max(0, A.state.endAt - Date.now() - 1000)); A.send({ t: 'timeup' }); await A.until(s => s.phase === 'done', 3000);
ok(A.state.phase === 'done' && A.state.result.reason === 'time' && A.state.result.winner === 0, '時間到 → 分數高的甲獲勝（time）');
E.ws.close(); await sleep(200);
console.log('⑨ 防護');
const D = client(code, 'D'); await D.ready; D.ws.send('x'.repeat(3000)); await sleep(300); ok(D.ws.readyState >= 2, '超大訊息會被斷線');
const evil = new WebSocket(`${WS}/api/room/${code}/ws`, { headers: { Origin: 'https://evil.example' }, agent: wsAgent }); const evilRes = await new Promise(r => { evil.on('unexpected-response', (q, res) => r(res.statusCode)); evil.on('open', () => r('open')); evil.on('error', () => r('err')); });
ok(evilRes === 403, `陌生來源不能連 WebSocket（${evilRes}）`);

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n🎉 全部通過'); for (const c of [A, B, B2, C, D, E, W]) { try { c.ws.close(); } catch (e) {} } process.exit(fail ? 1 : 0);
