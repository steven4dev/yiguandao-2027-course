// 投壺多人房間伺服器測試：node test/touhu.test.mjs（先在另一個終端機啟動 npm run dev，用縮短的計時器）
// 本機計時器請這樣啟動：npx wrangler dev --local --port 8787 --var COUNTDOWN_MS:300 --var REVEAL_MS:700 --var TURN_REVEAL_MS:300 --var ACK_WAIT_MS:600 --var STALL_MS:3000 --var SYNC_STALL_MS:4000 --var DC_GRACE_MS:1500
import WebSocket from 'ws';
const BASE = process.env.BASE || 'http://localhost:8787', WS = BASE.replace(/^http/, 'ws'), ORIGIN = 'http://localhost:8765';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  ✗', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, msg = 'timeout') { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(25); } throw new Error(msg + ' @' + new Error().stack.split('\n')[2]); }
async function create(host = false) { const r = await fetch(BASE + '/api/create', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ host }) }); return r.json(); }
class C {
  constructor(code, name, opts = {}) { this.code = code; this.name = name; this.msgs = []; this.st = null; this.opts = opts; }
  async connect(join = {}) {
    this.ws = new WebSocket(`${WS}/api/room/${this.code}/ws`, { headers: { Origin: ORIGIN } });
    this.ws.on('message', (d) => { const m = JSON.parse(d); this.msgs.push(m); if (m.t === 'state') this.st = m; if (m.t === 'welcome' && m.pid) { this.pid = m.pid; this._slot = m.slot; } });
    await new Promise((r, j) => { this.ws.on('open', r); this.ws.on('error', j); });
    this.send({ t: 'join', name: this.name, ...join }); if (!join.watch) await until(() => this.pid); else await until(() => this.st);
    return this;
  }
  get slot() { return this.st && this.st.you >= 0 ? this.st.you : this._slot; }   // 座位以最新快照為準（房間改類型時伺服器會重新排座位）
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
  got(t) { return this.msgs.filter((m) => m.t === t); }
}
const lobby = async (n, set = {}) => {
  const { code } = await create(); const cs = [];
  for (let i = 0; i < n; i++) cs.push(await new C(code, 'P' + i).connect());
  if (Object.keys(set).length) { cs[0].send({ t: 'set', ...set }); await until(() => cs[0].st.kind === (set.kind || cs[0].st.kind) && (!set.pace || cs[0].st.pace === set.pace)); }
  return { code, cs };
};
const readyAll = async (cs) => { cs.forEach((c) => c.send({ t: 'ready', ready: true })); await until(() => cs.every((c) => c.st.phase === 'play')); await sleep(450); };
const ev = (c, u, i, kind, rep) => c.send({ t: 'ev', u, i, kind, rep });
const unitScore = (c, u) => c.st.units[u].score;

// ---------- 1. 一對一・同場 ----------
console.log('1v1 同場');
{
  const { cs } = await lobby(2); const [A, B] = cs;
  ok(A.st.kind === '1v1' && A.st.pace === 'sync', '預設 1v1 同場');
  ok(A.st.players.filter(Boolean).length === 2 && A.st.you === 0 && B.st.you === 1, '座位 0、1');
  B.send({ t: 'set', pace: 'turn' }); await sleep(150); ok(A.st.pace === 'sync', '不是房主不能改選項');
  A.send({ t: 'ready', ready: true }); await sleep(100); ok(A.st.phase === 'lobby', '一人準備不會開始');
  B.send({ t: 'ready', ready: true }); await until(() => A.st.phase === 'play'); ok(A.st.seed > 0 && A.st.seed === B.st.seed, '兩人拿到同一個種子');
  await sleep(450);
  ev(A, 0, 1, 'in'); await sleep(150); ok(unitScore(A, 0) === 0, '跳號（i 不對）被忽略');
  ev(A, 0, 0, 'in', [1, 2, 3, 4, 5, 6]); await until(() => B.got('ev').length === 1); const e = B.got('ev')[0];
  ok(e.slot === 0 && e.kind === 'in' && e.pts === 2 && e.rep.length === 6, '對手收到這矢的結果與重播');
  ok(A.got('ev').length === 0, '自己不會收到自己的重播');
  ev(B, 0, 0, 'miss'); await sleep(150); ok(unitScore(B, 0) === 20 && unitScore(B, 1) === 0, 'B 不能代替 A 投');
  ev(A, 0, 1, 'ear'); ev(A, 0, 2, 'miss'); ev(A, 0, 3, 'in'); ev(A, 0, 4, 'in'); await sleep(200); ok(A.st.units[0].done === 4, '同場：本輪最多 4 矢，不能超前');
  ok(!A.st.reveal, 'B 還沒投完，不對帳');
  for (let i = 0; i < 4; i++) ev(B, 1, i, 'ear'); await until(() => A.st.reveal, 3000, '對帳');
  ok(A.st.reveal.r === 0 && A.st.teams[0] === 70 && A.st.teams[1] === 120, '第一輪分數 7 : 12（單位：十分之一分）');
  await until(() => A.st.round === 1 && !A.st.reveal, 3000, '下一輪');
  for (let r = 1; r < 3; r++) { for (let i = 0; i < 4; i++) { ev(A, 0, r * 4 + i, 'in'); ev(B, 1, r * 4 + i, 'in'); } await until(() => A.st.reveal || A.st.phase === 'end', 3000); await until(() => !A.st.reveal || A.st.phase === 'end', 3000); }
  await until(() => A.st.phase === 'end', 3000, '結束');
  ok(A.st.result.winner === 1 && A.st.result.teams[0] === 230 && A.st.result.teams[1] === 280, '結果：B 勝 28 : 23');
  A.send({ t: 'rematch' }); await until(() => A.st.phase === 'lobby'); ok(A.st.players.every((p) => p && !p.ready) && !A.st.units, '重賽回到大廳');
  cs.forEach((c) => c.close());
}
// ---------- 2. 平手加賽 ----------
console.log('平手加賽');
{
  const { cs } = await lobby(2); const [A, B] = cs; await readyAll(cs);
  for (let r = 0; r < 3; r++) { for (let i = 0; i < 4; i++) { ev(A, 0, r * 4 + i, 'in'); ev(B, 1, r * 4 + i, 'in'); } await until(() => A.st.reveal || A.st.round > r, 3000); await until(() => !A.st.reveal, 3000); }
  await until(() => A.st.round === 3 && A.st.sudden === 1, 3000, '同分進加賽');
  ev(A, 0, 12, 'ear'); ev(B, 1, 12, 'miss'); await until(() => A.st.phase === 'end', 4000, '加賽結束');
  ok(A.st.result.winner === 0 && A.st.result.teams[0] === 270 && A.st.result.teams[1] === 240, '加賽分出勝負 27 : 24');
  cs.forEach((c) => c.close());
}
// ---------- 3. 一對一・輪流 ----------
console.log('1v1 輪流');
{
  const { cs } = await lobby(2, { pace: 'turn' }); const [A, B] = cs; await readyAll(cs);
  ok(A.st.turn && A.st.turn.u === 0 && A.st.turn.i === 0, '先 A 後 B');
  ev(B, 1, 0, 'in'); await sleep(150); ok(unitScore(A, 1) === 0, '沒輪到不能投');
  ev(A, 0, 0, 'in', [9, 8, 7]); await until(() => B.got('ev').length === 1); ok(B.got('ev')[0].rep.length === 3, '輪流：對手收到重播');
  await sleep(150); ok(A.st.turn.u === 0, '重播還沒看完，先不換人（B 還沒 ack）');
  B.send({ t: 'ack', u: 0, i: 0 }); await until(() => A.st.turn && A.st.turn.u === 1 && A.st.turn.i === 0, 2000, '換 B'); ok(true);
  ev(B, 1, 0, 'ear'); await until(() => A.got('ev').length === 1); await sleep(900); ok(A.st.turn && A.st.turn.u === 0 && A.st.turn.i === 1, '不 ack 也會在等待時間後換人');
  // 把這輪投完
  for (let i = 1; i < 4; i++) {
    await until(() => A.st.turn && A.st.turn.u === 0 && A.st.turn.i === i, 3000, 'A 的回合 ' + i); ev(A, 0, i, 'miss'); await sleep(80); B.send({ t: 'ack' }); B.send({ t: 'ack', u: 0, i });
    await until(() => A.st.turn && A.st.turn.u === 1 && A.st.turn.i === i, 3000, 'B 的回合 ' + i); ev(B, 1, i, 'miss'); await sleep(80); A.send({ t: 'ack', u: 1, i });
  }
  await until(() => A.st.reveal, 3000, '輪流：本輪結束對帳'); ok(A.st.reveal.r === 0 && A.st.teams[0] === 20 && A.st.teams[1] === 30, '輪流第一輪 2 : 3');
  cs.forEach((c) => c.close());
}
// ---------- 4. 二對二・分工合投 ----------
console.log('2v2 分工合投');
{
  const { cs } = await lobby(2); cs[0].send({ t: 'set', kind: '2v2', rule: 'split' }); await until(() => cs[0].st.kind === '2v2');
  const c2 = await new C(cs[0].code, 'P2').connect(), c3 = await new C(cs[0].code, 'P3').connect(); const all = [...cs, c2, c3];
  await until(() => all.every((c) => c.st.players.filter(Boolean).length === 4));
  // 座位順序：紅1(0) 藍1(2) 紅2(1) 藍2(3)
  ok(cs[0].slot === 0 && cs[1].slot === 2 && c2.slot === 1 && c3.slot === 3, '座位依加入順序 0、2、1、3');
  all.forEach((c) => c.send({ t: 'ready', ready: true })); await until(() => all.every((c) => c.st.phase === 'play')); await sleep(450);
  const g = (slot) => all.find((c) => c.slot === slot);
  ok(cs[0].st.units.length === 2 && cs[0].st.units[0].members.join() === '0,1', '分工合投：兩個隊伍單位');
  // 紅隊（成員 0、1）分工：第 i 矢由 members[i%2] 定仰角與力道、另一位定左右並放箭
  // 第 0 矢：slot0 定、slot1 放箭
  g(1).send({ t: 'lock', u: 0, i: 0, e: 0.4, p: 0.4 }); await sleep(120); ok(g(0).got('lock').length === 0, '放箭的人（slot1）不能 lock 第 0 矢');
  g(0).send({ t: 'lock', u: 0, i: 1, e: 0.4, p: 0.4 }); await sleep(120); ok(g(1).got('lock').length === 0, '錯的矢號 lock 被忽略');
  g(0).send({ t: 'lock', u: 0, i: 0, e: 0.5, p: 0.3 }); await until(() => g(1).got('lock').length === 1); const lk0 = g(1).got('lock')[0];
  ok(lk0.i === 0 && lk0.e === 0.5 && lk0.p === 0.3, 'slot1 收到 slot0 鎖定的仰角與力道');
  ev(g(0), 0, 0, 'in'); await sleep(120); ok(unitScore(cs[0], 0) === 0, '定參數的人（slot0）不能放箭');
  ev(g(1), 0, 0, 'in'); await sleep(150); ok(unitScore(cs[0], 0) === 20, 'slot1 放箭：入壺 +2');
  // 第 1 矢：角色互換，slot1 定、slot0 放箭
  g(1).send({ t: 'lock', u: 0, i: 1, e: 0.6, p: 0.25 }); await until(() => g(0).got('lock').length === 1); const lk1 = g(0).got('lock')[0];
  ok(lk1.i === 1 && lk1.e === 0.6 && lk1.p === 0.25, '第 1 矢角色互換：slot0 收到 slot1 的仰角與力道');
  g(0).send({ t: 'profile', name: 'P0' }); await sleep(150);   // 觸發一次快照（隊友重連時就是拿這份）
  ok(g(0).st.lock && g(0).st.lock.i === 1 && g(0).st.lock.e === 0.6, '快照也帶著這組 lock（重連用）');
  ev(g(0), 0, 1, 'ear'); await sleep(150); ok(unitScore(cs[0], 0) === 50, 'slot0 放箭：貫耳 +3，紅隊 5 分');
  ev(g(1), 0, 2, 'miss'); await sleep(80); ev(g(0), 0, 3, 'miss'); await sleep(150);   // 兩個連線的訊息到達順序不保證，要依序送 ok(cs[0].st.units[0].done === 4, '紅隊 4 矢');
  // 藍隊（成員 2、3）全部入壺，各矢由放箭的人回報
  for (let i = 0; i < 4; i++) { const th = g(i % 2 === 0 ? 3 : 2); ev(th, 1, i, 'in'); } await until(() => cs[0].st.reveal, 3000);
  ok(cs[0].st.teams[0] === 50 && cs[0].st.teams[1] === 80, '二對二第一輪 5 : 8');
  all.forEach((c) => c.close());
}
// ---------- 5. 二對二・各自累計 ----------
console.log('2v2 各自累計');
{
  const { cs } = await lobby(1); cs[0].send({ t: 'set', kind: '2v2', rule: 'sum' }); await until(() => cs[0].st.kind === '2v2');
  const all = [cs[0]]; for (let i = 1; i < 4; i++) all.push(await new C(cs[0].code, 'P' + i).connect());
  all.forEach((c) => c.send({ t: 'ready', ready: true })); await until(() => all.every((c) => c.st.phase === 'play')); await sleep(450);
  ok(cs[0].st.units.length === 4, '累計：四個單位');
  all.forEach((c) => { for (let i = 0; i < 4; i++) ev(c, c.slot, i, c.slot < 2 ? 'in' : 'ear'); }); await until(() => cs[0].st.reveal, 3000);
  ok(cs[0].st.teams[0] === 160 && cs[0].st.teams[1] === 240, '累計：紅 2×8=16、藍 2×12=24');
  all.forEach((c) => c.close());
}
// ---------- 6. 斷線 ----------
console.log('斷線');
{
  const { cs } = await lobby(2); const [A, B] = cs; await readyAll(cs);
  ev(A, 0, 0, 'in'); await sleep(100); A.close();
  await sleep(2300); ok(B.st.players[0].gone === true, '掉線超過寬限：標記離場');
  for (let i = 0; i < 4; i++) ev(B, 1, i, 'ear'); await until(() => B.st.reveal || B.st.round >= 1, 3000, 'A 離場後，剩下的人不被卡住');
  ok(B.st.units[0].done >= 4, '離場者剩下的矢記 skip');
  B.close();
}
{
  const { cs } = await lobby(2); const [A, B] = cs; await readyAll(cs);
  A.close(); await sleep(500); const A2 = await new C(A.code, 'P0').connect({ pid: A.pid }); ok(A2.slot === 0 && A2.pid === A.pid, '寬限內用通行碼重連，拿回原位');
  ok(A2.st.phase === 'play', '重連後看到遊戲進度'); A2.close(); B.close();
}
// ---------- 時間加成 ----------
console.log('時間加成');
{
  const { cs } = await lobby(2); const [A, B] = cs; await readyAll(cs);
  const evt = (c, u, i, kind, tl) => c.send({ t: 'ev', u, i, kind, tl });
  evt(A, 0, 0, 'in', 1); await sleep(120); ok(unitScore(A, 0) === 25, '入壺 + 滿時間 ＝ 2.5');
  evt(A, 0, 1, 'ear', 0.5); await sleep(120); ok(unitScore(A, 0) === 25 + 33, '貫耳 + 剩一半 ＝ 3.3（加成 0.25 四捨五入成 0.3）');
  evt(A, 0, 2, 'miss', 1); await sleep(120); ok(unitScore(A, 0) === 58, '沒進沒有加成，就算時間滿');
  evt(A, 0, 3, 'in', 9); await sleep(120); ok(unitScore(A, 0) === 58 + 25, 'tl 超過 1 會被夾到 1，最多 +0.5');
  evt(B, 1, 0, 'in', -3); await sleep(120); ok(unitScore(B, 1) === 20, 'tl 小於 0 夾到 0，沒有加成');
  evt(B, 1, 1, 'in'); await sleep(120); ok(unitScore(B, 1) === 40, '沒帶 tl（舊版手機）一律 0 加成');
  evt(B, 1, 2, 'ear', 'abc'); await sleep(120); ok(unitScore(B, 1) === 70, '亂填的 tl 當 0');
  ok(A.st.units[0].hist[0].join() === '0,in,2,5', '紀錄帶著加成：[矢序, 種類, 基本分, 加成]');
  const e0 = B.got('ev')[0]; ok(e0 && e0.b === 5 && e0.pts === 2, '對手收到的重播資訊帶加成');
  cs.forEach((c) => c.close());
}
// ---------- 7. 電腦主持（觀戰）----------
console.log('電腦主持');
{
  const { code, hk } = await create(true); ok(!!hk, '電腦建房拿到主持金鑰');
  const host = await new C(code, 'host').connect({ watch: true, hk }); ok(host.got('welcome')[0].ctl === true, '持金鑰的觀戰畫面是主持人');
  const A = await new C(code, 'A').connect(), B = await new C(code, 'B').connect();
  host.send({ t: 'set', pace: 'turn' }); await until(() => A.st.pace === 'turn'); ok(true);
  host.send({ t: 'set', kind: '2v2' }); await until(() => A.st.kind === '2v2'); ok(A.st.players.length === 4, '主持人把房間改成 2 對 2');
  const watcher = await new C(code, 'w').connect({ watch: true }); watcher.send({ t: 'set', pace: 'sync' }); await sleep(150); ok(A.st.pace === 'turn', '一般觀戰者不能改選項');
  host.close(); A.close(); B.close(); watcher.close();
}
console.log(`\n${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
