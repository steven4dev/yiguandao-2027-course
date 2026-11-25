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
await A.until(s => s.players[1] && s.players[1].name === '乙'); ok(A.state.players[1] && A.state.players[1].name === '乙', '甲也即時看到乙');
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
console.log('⑩ 電腦建房（主持人）');
const hr = await api('/api/create', { method: 'POST', body: JSON.stringify({ host: true }) }); const hcode = hr.body.code, hk = hr.body.hk;
ok(hr.status === 200 && /^[A-HJ-NP-Z2-9]{5}$/.test(hcode) && /^[A-HJ-NP-Z2-9]{12}$/.test(hk), `電腦建房拿到房號 ${hcode} 和主持金鑰`);
ok(!(await api('/api/create', { method: 'POST' })).body.hk, '一般建房（手機）沒有主持金鑰');
ok((await api(`/api/room/${hcode}`)).body.cx === true, '房間資訊標示為電腦主持');
const H = client(hcode, 'H'); await H.ready; H.send({ t: 'join', watch: true, hk }); await H.until(s => s.cx === true);
ok(H.msgs.some(m => m.t === 'welcome' && m.watch && m.ctl === true), '帶金鑰的觀戰畫面＝主持人（ctl）');
const H2 = client(hcode, 'H2'); await H2.ready; H2.send({ t: 'join', watch: true, hk: 'WRONGKEY' }); await H2.until(s => s.cx === true);
ok(H2.msgs.some(m => m.t === 'welcome' && m.watch && m.ctl === false), '金鑰不對只是一般觀戰');
H2.send({ t: 'set', diff: 'hard' }); await sleep(250); ok(H.state.diff === 'easy', '一般觀戰不能改難度');
H.send({ t: 'set', diff: 'hard' }); await H.until(s => s.diff === 'hard'); ok(H.state.diff === 'hard', '主持人可以改難度');
const P1 = client(hcode, 'P1'); await P1.ready; P1.send({ t: 'join', name: '甲' }); await P1.until(s => s.you === 0);
ok(P1.state.host === -1 && P1.state.cx === true, '第一位玩家進房，不會變成房主（host = -1）');
P1.send({ t: 'set', diff: 'easy' }); await sleep(250); ok(P1.state.diff === 'hard', '玩家不能改難度（由電腦決定）');
const P2 = client(hcode, 'P2'); await P2.ready; P2.send({ t: 'join', name: '乙' }); await P2.until(s => s.you === 1);
H.send({ t: 'set', diff: 'normal' }); await P1.until(s => s.diff === 'normal'); ok(P2.state.diff === 'normal', '難度改了，兩位玩家都同步');
ok(!JSON.stringify([P1.msgs, P2.msgs, H2.msgs]).includes(hk), '金鑰不會出現在其他人收到的訊息裡');
P1.send({ t: 'ready', ready: true }); P2.send({ t: 'ready', ready: true }); await P1.until(s => s.phase === 'playing'); await H.until(s => s.phase === 'playing'); ok(P1.state.phase === 'playing' && H.state.phase === 'playing', '兩位玩家都準備就開打，電腦端也同步');
for (const c of [H, H2, P1, P2]) { try { c.ws.close(); } catch (e) {} }

console.log('⑪ 2 對 2 合作組隊');
const tr = await api('/api/create', { method: 'POST', body: JSON.stringify({ host: true }) }); const tcode = tr.body.code, thk = tr.body.hk;
const TH = client(tcode, 'TH'); await TH.ready; TH.send({ t: 'join', watch: true, hk: thk }); await TH.until(s => s.cx === true);
TH.send({ t: 'set', mode: 'team', diff: 'normal' }); await TH.until(s => s.mode === 'team'); ok(TH.state.mode === 'team' && TH.state.players.length === 4, '主持人把模式改成 2 對 2（4 個座位）');
const names = ['甲', '乙', '丙', '丁'], TP = []; for (const nm of names) { const c = client(tcode, nm); await c.ready; c.send({ t: 'join', name: nm }); await c.until(s => s.you >= 0); TP.push(c); }
ok(TP.map(c => c.state.you).join() === '0,2,1,3', '加入順序＝紅1、藍1、紅2、藍2（座位 0,2,1,3），兩隊人數一樣');
ok(TH.state.players.map(p => p && p.team).join() === '0,0,1,1', '座位 0、1 是紅隊，2、3 是藍隊');
const [PA, PB, PC, PD] = TP;   // 甲＝座位0（紅1）、乙＝座位2（藍1）、丙＝座位1（紅2）、丁＝座位3（藍2）
PA.send({ t: 'set', diff: 'hard' }); await sleep(200); ok(TH.state.diff === 'normal', '玩家（沒有房主）不能改難度');
TP.slice(0, 3).forEach(c => c.send({ t: 'ready', ready: true })); await sleep(300); ok(TH.state.phase === 'lobby', '只有 3 人準備，不開打（要 4 個人都準備）');
PD.send({ t: 'ready', ready: true }); for (const c of TP) await c.until(s => s.phase === 'playing'); ok(PA.state.phase === 'playing' && TH.state.teams && TH.state.teams.length === 2, '4 人都準備就開打，狀態帶著兩隊資料');
ok(TH.state.teams[0].lives === 4 && TH.state.teams[1].lives === 4, '全隊共用 4 盞心燈（修行）');
await sleep(PA.state.startAt - Date.now() + 700);
const st = c => c.state.teams;
// 紅隊第 0 隻是兩招：第 0 步輪到座位 0（甲），第 1 步輪到座位 1（丙）
PC.send({ t: 'step', n: 0, s: 0, ok: true, k: 2, stage: 1, fam: 'se' }); await sleep(200); ok(st(PA)[0].s === 0, '不是輪到你的步驟會被忽略（丙不能先揮）');
PA.send({ t: 'step', n: 0, s: 0, ok: true, k: 2, stage: 1, fam: 'se' }); await PC.until(s => s.teams[0].s === 1); ok(st(PC)[0].s === 1 && st(PC)[0].k === 2, '甲揮完第 1 招，輪到隊友丙');
PC.send({ t: 'step', n: 0, s: 1, ok: true, k: 2, stage: 1, fam: 'se' }); await PA.until(s => s.teams[0].n === 1);
ok(st(PA)[0].score === 150 && st(PA)[0].lastOk === true && st(PA)[0].lastN === 0, '丙揮完第 2 招，連擊淨化 +150');
ok(!JSON.stringify([TP, TH.msgs]).includes(tr.body.hk), '主持金鑰沒有外流');
// 藍隊第 0 隻是單招：輪到座位 (0+0)%2＝2（乙），失敗 → 全隊少一盞心燈
PB.send({ t: 'step', n: 0, s: 0, ok: false, k: 1, stage: 1, fam: 'sheng' }); await PD.until(s => s.teams[1].n === 1); ok(st(PD)[1].lives === 3 && st(PD)[1].lastOk === false && st(PD)[1].score === 0, '乙失手：藍隊共用心燈 4 → 3，隊友丁也看得到');
// 紅隊第 1 隻是三招：第 0 步 (1+0)%2＝座位 1（丙），第 1 步座位 0（甲），第 2 步兩人一起
PC.send({ t: 'step', n: 1, s: 0, ok: true, k: 3, stage: 2, fam: 'xiang' }); await PA.until(s => s.teams[0].s === 1);
PA.send({ t: 'step', n: 1, s: 1, ok: true, k: 3, stage: 2, fam: 'xiang' }); await PC.until(s => s.teams[0].s === 2);
ok(st(PC)[0].cueAt > Date.now() && st(PC)[0].cueAt - Date.now() < 3000, '第 3 步：伺服器給一個同步的「揮」時間，兩支手機一起倒數');
PA.send({ t: 'step', n: 1, s: 2, ok: true, k: 3, stage: 2, fam: 'xiang' }); await sleep(250); ok(st(PC)[0].n === 1 && st(PC)[0].s === 2, '兩人一起的那一步，只有一個人回報還不算');
PC.send({ t: 'step', n: 1, s: 2, ok: true, k: 3, stage: 2, fam: 'xiang' }); await PA.until(s => s.teams[0].n === 2);
ok(st(PA)[0].score === 150 + 140 + 100 + 10 && st(PA)[0].lastK === 3, '三招一起揮成功：140 + 100 + 連擊 10，紅隊 400');
await sleep(150); ok(PB.fx.length === 2 && PD.fx.length === 2 && PB.fx.some(f => f.fam === 'xiang') && !PA.fx.length && !PC.fx.length, '紅隊兩次連擊 → 藍隊兩位各收到 2 次干擾（含香系），自己人沒有');
ok(TH.msgs.some(m => m.t === 'tdone' && m.team === 0 && m.k === 3 && m.ok) && TH.msgs.some(m => m.t === 'tstep' && m.s === 2), '觀戰畫面收到每一步與每隻怪的結果');
// 三招第 3 步：一人成功、一人失敗 → 整隻失敗
PA.send({ t: 'step', n: 2, s: 0, ok: true, k: 3, stage: 2, fam: 'se' }); await PC.until(s => s.teams[0].s === 1); PC.send({ t: 'step', n: 2, s: 1, ok: true, k: 3, stage: 2, fam: 'se' }); await PA.until(s => s.teams[0].s === 2);
PA.send({ t: 'step', n: 2, s: 2, ok: true, k: 3, stage: 2, fam: 'se' }); PC.send({ t: 'step', n: 2, s: 2, ok: false, k: 3, stage: 2, fam: 'se' }); await PA.until(s => s.teams[0].n === 3);
ok(st(PA)[0].lastOk === false && st(PA)[0].lives === 3 && st(PA)[0].combo === 0 && st(PA)[0].score === 400, '一人失手整隻失敗：心燈 −1、連擊歸零，分數不變');
// 卡住：太早請求不會判失敗
PB.send({ t: 'stall', n: 1, s: 0 }); await sleep(250); ok(st(PD)[1].n === 1, '剛開始等隊友，太早喊「卡住」不會判失敗');
// 時間到：比隊伍分數（測試環境 5 秒）
await sleep(Math.max(0, PA.state.endAt - Date.now() - 1400)); PA.send({ t: 'timeup' }); await TH.until(s => s.phase === 'done', 6000);
const tres = TH.state.result; ok(tres && tres.mode === 'team' && tres.winner === 0 && tres.reason === 'time' && tres.teams[0].score === 400 && tres.teams[1].score === 0, '時間到：紅隊 400 比 0 獲勝');
ok(tres.players.length === 4 && tres.players[0].name === '甲' && tres.players[0].score + tres.players[1].score === 400, '結算帶四位玩家與各自貢獻（甲＋丙 = 400）');
PA.send({ t: 'rematch' }); await TH.until(s => s.phase === 'lobby'); ok(TH.state.teams === null && TH.state.mode === 'team' && TH.state.players.every(p => p && !p.ready), '再來一局：回大廳、保留 2 對 2 和座位');
for (const c of [TH, ...TP]) { try { c.ws.close(); } catch (e) {} }

console.log('⑫ 2 對 2：隊友斷線 → 剩下的人包辦');
const ur = await api('/api/create', { method: 'POST', body: JSON.stringify({ host: true }) }); const ucode = ur.body.code, uhk = ur.body.hk;
const UH = client(ucode, 'UH'); await UH.ready; UH.send({ t: 'join', watch: true, hk: uhk }); await UH.until(s => s.cx === true); UH.send({ t: 'set', mode: 'team' }); await UH.until(s => s.mode === 'team');
const UP = []; for (const nm of names) { const c = client(ucode, nm); await c.ready; c.send({ t: 'join', name: nm }); await c.until(s => s.you >= 0); UP.push(c); }
UP.forEach(c => c.send({ t: 'ready', ready: true })); await UP[0].until(s => s.phase === 'playing'); await sleep(UP[0].state.startAt - Date.now() + 700);
UP[1].send({ t: 'leave' }); await UP[3].until(s => s.teams && s.teams[1].solo === 3, 3000);   // 乙（座位2）離開，丁（座位3）變成藍隊唯一的人
ok(UP[3].state.teams[1].solo === 3 && UP[3].state.phase === 'playing', '乙離開：藍隊改由丁一個人揮，比賽繼續');
UP[3].send({ t: 'step', n: 0, s: 0, ok: true, k: 1, stage: 1, fam: 'se' }); await UP[3].until(s => s.teams[1].n === 1); ok(UP[3].state.teams[1].score === 100, '丁一個人也能完成怪（原本輪到乙的那一步）');
UP[3].send({ t: 'leave' }); await UH.until(s => s.phase === 'done', 3000); ok(UH.state.result.winner === 0 && UH.state.result.reason === 'forfeit', '藍隊兩人都走了 → 紅隊獲勝（forfeit）');
for (const c of [UH, ...UP]) { try { c.ws.close(); } catch (e) {} }

console.log('⑨ 防護');
const D = client(code, 'D'); await D.ready; D.ws.send('x'.repeat(3000)); await sleep(300); ok(D.ws.readyState >= 2, '超大訊息會被斷線');
const evil = new WebSocket(`${WS}/api/room/${code}/ws`, { headers: { Origin: 'https://evil.example' }, agent: wsAgent }); const evilRes = await new Promise(r => { evil.on('unexpected-response', (q, res) => r(res.statusCode)); evil.on('open', () => r('open')); evil.on('error', () => r('err')); });
ok(evilRes === 403, `陌生來源不能連 WebSocket（${evilRes}）`);

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n🎉 全部通過'); for (const c of [A, B, B2, C, D, E, W]) { try { c.ws.close(); } catch (e) {} } process.exit(fail ? 1 : 0);
