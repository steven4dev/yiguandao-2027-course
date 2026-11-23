/* 投壺島・多人對戰：房間伺服器
   - 一個房間 = 一個 Durable Object（名字是 5 碼房號），用 WebSocket 連線，使用休眠 API（沒人說話時不計時）
   - 動作與物理都在各自手機上跑，伺服器只管：座位、選項、同一個種子、依序驗證每一矢、算分、輪次關卡、輪流指標、斷線處理、平手加賽
   - 只存暱稱，不存任何個資；房間閒置 30 分鐘自動清掉

   對戰類型 kind：'1v1'（2 人）、'2v2'（4 人，座位 0、1＝紅隊，2、3＝藍隊）
   節奏 pace：'sync'＝同場對投（各投各的，每輪結束才對帳）、'turn'＝輪流對投（你投我看重播）
   2v2 規則 rule：'split'＝分工合投（隊友 A 定仰角與力道，隊友 B 定左右並放箭，每矢互換）、'sum'＝各自投、隊伍累計
   「單位 unit」＝計分的最小單位：1v1 與 2v2-sum 是每位玩家；2v2-split 是每個隊伍
   每個單位三輪、每輪 4 矢；三輪後同分就加賽，每個單位 1 矢，最多 3 次 */
import { DurableObject } from 'cloudflare:workers';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 I、O、0、1
const CODE_LEN = 5, MAX_WATCHERS = 8, IDLE_MS = 30 * 60 * 1000;
const PER_ROUND = 4, ROUNDS = 3, SUDDEN_MAX = 3;
const SEATS = { '1v1': [0, 1], '2v2': [0, 2, 1, 3] }, MAXP = { '1v1': 2, '2v2': 4 };
const KINDS = ['1v1', '2v2'], PACES = ['sync', 'turn'], RULES = ['split', 'sum'], PTS = { in: 2, ear: 3, miss: 0 };
const MAX_MSG = 14000;
const CFG = (env) => ({
  COUNTDOWN: +env.COUNTDOWN_MS || 4000, REVEAL: +env.REVEAL_MS || 9000, TURN_REVEAL: +env.TURN_REVEAL_MS || 4000, ACK_WAIT: +env.ACK_WAIT_MS || 9000,
  STALL: +env.STALL_MS || 70000, SYNC_STALL: +env.SYNC_STALL_MS || 180000, DC_GRACE: +env.DC_GRACE_MS || 20000,
});
const cors = (env, req) => { const o = req.headers.get('Origin') || '', ok = allowed(env, o); return { 'Access-Control-Allow-Origin': ok ? o : 'null', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }; };
const allowed = (env, origin) => !!origin && String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
const genCode = () => { const b = crypto.getRandomValues(new Uint8Array(CODE_LEN)); return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join(''); };
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10) || '賓客';
// 每個單位第 r 輪結束時，累計應該投完幾矢
const need = (r) => (r < ROUNDS ? (r + 1) * PER_ROUND : ROUNDS * PER_ROUND + (r - ROUNDS + 1));
const startOf = (r) => (r === 0 ? 0 : need(r - 1));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), c = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{3,8})(\/ws)?$/);
    if (url.pathname === '/api/create' && req.method === 'POST') {
      // 電腦建房（host:true）：多給一把「主持金鑰」，拿著它的觀戰畫面可以設定對戰選項；這種房間的玩家沒有房主
      let body = {}; try { const t = await req.text(); if (t && t.length < 500) body = JSON.parse(t) || {}; } catch (e) {}
      const hk = body.host === true ? [...crypto.getRandomValues(new Uint8Array(12))].map((x) => ALPHABET[x % ALPHABET.length]).join('') : null;
      for (let i = 0; i < 8; i++) {
        const code = genCode(), stub = env.ROOMS.get(env.ROOMS.idFromName(code)), r = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ hk }) });
        if (r.status === 200) return json(hk ? { code, hk } : { code }, 200, c);
      }
      return json({ error: 'busy' }, 503, c);
    }
    if (m) {
      const code = normCode(m[1]); if (code.length !== CODE_LEN) return json({ error: 'bad_code' }, 400, c);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (m[2] === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
        if (!allowed(env, req.headers.get('Origin'))) return new Response('forbidden origin', { status: 403 });
        return stub.fetch('https://room/ws', req);
      }
      const r = await stub.fetch('https://room/info'); return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...c } });
    }
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'touhu-room' }, 200, c);
    return json({ error: 'not_found' }, 404, c);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = null; this.cfg = CFG(env); ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get('s')) || null; }); }
  async save() { await this.ctx.storage.put('s', this.s); await this.schedule(); }
  newState(hk) { return { hk: hk || null, kind: '1v1', pace: 'sync', rule: 'split', phase: 'lobby', host: null, seed: 0, startAt: 0, g: null, result: null, players: {}, touched: Date.now() }; }

  // —— 小工具 ——
  maxP() { return MAXP[this.s.kind]; }
  byPid(pid) { return this.s.players[pid] || null; }
  bySlot(slot) { return Object.values(this.s.players).find((p) => p.slot === slot) || null; }
  alive(slot) { const p = this.bySlot(slot); return !!p && !p.gone; }
  sockets() { return this.ctx.getWebSockets(); }
  att(w) { try { return w.deserializeAttachment() || {}; } catch (e) { return {}; } }
  isConnected(pid) { return this.sockets().some((w) => w !== this.closing && this.att(w).pid === pid); }
  watchers() { return this.sockets().filter((w) => this.att(w).watch === true); }
  sendWs(w, obj) { try { w.send(JSON.stringify(obj)); } catch (e) {} }
  sendSlot(slot, obj, except) { const p = this.bySlot(slot); if (!p) return; for (const w of this.sockets()) if (this.att(w).pid === p.pid && w !== except) this.sendWs(w, obj); }
  toAll(obj, exceptSlot) { const t = JSON.stringify(obj); for (const w of this.sockets()) { const a = this.att(w); if (exceptSlot !== undefined && a.pid && this.byPid(a.pid) && this.byPid(a.pid).slot === exceptSlot) continue; try { w.send(t); } catch (e) {} } }

  // —— 單位（計分的最小單位）——
  unitsFor() {
    const s = this.s;
    if (s.kind === '1v1') return [0, 1].map((i) => ({ id: i, members: [i], team: i, score: 0, done: 0, hist: [], lock: null }));
    if (s.rule === 'sum') return [0, 1, 2, 3].map((i) => ({ id: i, members: [i], team: i >> 1, score: 0, done: 0, hist: [], lock: null }));
    return [0, 1].map((t) => ({ id: t, members: [t * 2, t * 2 + 1], team: t, score: 0, done: 0, hist: [], lock: null }));
  }
  // 這一矢的分工：單人單位自己鎖自己投；分工合投時 members[i%2] 定仰角與力道，另一位定左右並放箭；隊友不在了，剩下的人包辦
  roles(u, i) {
    if (u.members.length === 1) return { lock: null, thrower: u.members[0], solo: false };
    const live = u.members.filter((m) => this.alive(m));
    if (live.length === 1) return { lock: null, thrower: live[0], solo: true };
    return { lock: u.members[i % 2], thrower: u.members[(i + 1) % 2], solo: false };
  }
  unitAlive(u) { return u.members.some((m) => this.alive(m)); }
  teamScores() { const g = this.s.g; if (!g) return [0, 0]; const t = [0, 0]; for (const u of g.units) t[u.team] += u.score; return t; }
  turnOrder() { const s = this.s; return s.kind === '1v1' || s.rule === 'split' ? [0, 1] : [0, 2, 1, 3]; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') { if (this.s) return new Response('exists', { status: 409 }); let b = {}; try { b = await req.json(); } catch (e) {} this.s = this.newState(typeof b.hk === 'string' ? b.hk.slice(0, 24) : null); await this.save(); return new Response('ok'); }
    if (!this.s) return json({ exists: false }, 404);
    if (url.pathname === '/info') { const n = Object.keys(this.s.players).length; return json({ exists: true, phase: this.s.phase, players: n, cx: !!this.s.hk, kind: this.s.kind, pace: this.s.pace, rule: this.s.rule, full: n >= this.maxP() }); }
    if (url.pathname === '/ws') { const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); return new Response(null, { status: 101, webSocket: pair[0] }); }
    return new Response('not found', { status: 404 });
  }

  // —— 給每個人的快照（不含別人的通行碼）——
  snapshot(forPid) {
    const s = this.s, me = this.byPid(forPid), g = s.g, now = Date.now();
    const out = {
      t: 'state', cx: !!s.hk, kind: s.kind, pace: s.pace, rule: s.rule, phase: s.phase, seed: s.seed, startIn: Math.max(0, s.startAt - now),
      you: me ? me.slot : -1, host: s.host ? (this.byPid(s.host) || {}).slot ?? -1 : -1,
      players: Array.from({ length: this.maxP() }, (_, i) => i).map((i) => { const p = this.bySlot(i); return p ? { slot: i, team: s.kind === '2v2' ? i >> 1 : i, name: p.name, avatar: p.avatar, ready: p.ready, online: this.isConnected(p.pid), gone: !!p.gone, input: p.input } : null; }),
      teams: this.teamScores(), result: s.result,
    };
    if (g) {
      out.round = g.round; out.sudden = g.sudden;
      out.units = g.units.map((u) => ({ id: u.id, members: u.members, team: u.team, score: u.score, done: u.done, hist: u.hist.map((h) => [h.i, h.kind, h.pts]) }));
      out.turn = s.pace === 'turn' && g.queue && !g.reveal && g.tp < g.queue.length ? { u: g.queue[g.tp][0], i: g.queue[g.tp][1] } : null;
      out.reveal = g.reveal ? { r: g.reveal.r, ms: Math.max(0, g.reveal.until - now) } : null;
      // 分工合投：隊友已經鎖好、正等你放箭的仰角與力道（重連也拿得到）
      if (me) { const u = g.units.find((x) => x.members.includes(me.slot)); if (u && u.lock && u.lock.i === u.done) out.lock = { u: u.id, i: u.lock.i, e: u.lock.e, p: u.lock.p }; }
    }
    return out;
  }
  broadcast() { for (const w of this.sockets()) this.sendWs(w, this.snapshot(this.att(w).pid)); }

  // —— 開始、輪次、結束 ——
  allReady() { const ps = Object.values(this.s.players); return ps.length === this.maxP() && ps.every((p) => p.ready); }
  startGame() {
    const s = this.s; s.phase = 'play'; s.result = null; s.seed = crypto.getRandomValues(new Uint32Array(1))[0]; s.startAt = Date.now() + this.cfg.COUNTDOWN;
    s.g = { units: this.unitsFor(), round: 0, sudden: 0, reveal: null, queue: null, tp: 0, wait: null, turnAt: 0, lastEv: Date.now() + this.cfg.COUNTDOWN };
    if (s.pace === 'turn') this.buildQueue();
  }
  buildQueue() {
    const s = this.s, g = s.g, q = [], order = this.turnOrder();
    for (let i = startOf(g.round); i < need(g.round); i++) for (const id of order) q.push([id, i]);
    g.queue = q; g.tp = 0; g.wait = null; g.turnAt = Date.now() + (g.round === 0 ? this.cfg.COUNTDOWN : 0); this.skipDeadTurns();
  }
  skipDeadTurns() {   // 輪流：輪到的單位已經沒人在了，直接跳過（記一個 skip）
    const g = this.s.g; if (!g || !g.queue) return;
    while (g.tp < g.queue.length) { const [id, i] = g.queue[g.tp], u = g.units[id]; if (this.unitAlive(u)) break; this.record(u, i, 'skip', 0); g.tp++; }
    g.turnAt = Date.now();
  }
  record(u, i, kind, pts) { u.done = i + 1; u.score += pts; u.hist.push({ i, kind, pts }); u.lock = null; }
  roundDone() { const g = this.s.g; return g.units.every((u) => !this.unitAlive(u) || u.done >= need(g.round)); }
  beginReveal() {
    const g = this.s.g; if (g.reveal) return;
    g.lastEv = Date.now(); g.reveal = { r: g.round, until: Date.now() + (this.s.pace === 'turn' ? this.cfg.TURN_REVEAL : this.cfg.REVEAL) }; g.wait = null;
  }
  nextRound() {
    const s = this.s, g = s.g; g.reveal = null;
    if (g.round >= ROUNDS - 1) {   // 三輪（或加賽）打完：看分數
      const t = this.teamScores();
      if (t[0] === t[1] && g.sudden < SUDDEN_MAX) { g.sudden++; g.round = ROUNDS - 1 + g.sudden; }
      else { s.phase = 'end'; s.result = { teams: t, winner: t[0] === t[1] ? -1 : t[0] > t[1] ? 0 : 1, units: g.units.map((u) => ({ id: u.id, score: u.score, hist: u.hist.map((h) => [h.i, h.kind, h.pts]) })) }; return; }
    } else g.round++;
    // 沒人在的單位，補滿 skip，避免卡住
    for (const u of g.units) if (!this.unitAlive(u)) while (u.done < need(g.round)) this.record(u, u.done, 'skip', 0);
    if (s.pace === 'turn') this.buildQueue();
  }
  // 同場：每位都投完這輪才對帳
  checkBarrier() { const g = this.s.g; if (this.s.pace === 'sync' && g && !g.reveal && this.s.phase === 'play' && this.roundDone()) this.beginReveal(); }
  // 輪流：這一矢的重播大家看完（都 ack，或等太久）就換下一位
  advanceTurn() {
    const g = this.s.g; if (!g || !g.queue) return; g.wait = null; g.tp++; this.skipDeadTurns();
    if (g.tp >= g.queue.length) this.beginReveal();
  }
  waitingFor() { const g = this.s.g, w = g.wait; if (!w) return []; return Object.values(this.s.players).filter((p) => !p.gone && p.slot !== w.slot && this.isConnected(p.pid) && !w.acks.includes(p.slot)); }

  // —— 休眠 API：訊息 ——
  async webSocketMessage(ws, raw) {
    if (!this.s) { ws.close(1011, 'no room'); return; }
    if (typeof raw !== 'string' || raw.length > MAX_MSG) { ws.close(1009, 'too big'); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const a = this.att(ws), s = this.s; s.touched = Date.now();
    if (m.t === 'ping') { this.sendWs(ws, { t: 'pong', c: m.c, s: Date.now() }); return; }
    if (m.t === 'join' && m.watch) {   // 觀戰（大螢幕）：不佔位置、不能操作，只收廣播；持有主持金鑰的就是電腦主持人
      if (this.watchers().filter((w) => w !== ws).length >= MAX_WATCHERS) { this.sendWs(ws, { t: 'error', code: 'watch_full' }); return; }
      const ctl = !!(s.hk && typeof m.hk === 'string' && m.hk === s.hk);
      ws.serializeAttachment({ watch: true, ctl }); this.sendWs(ws, { t: 'welcome', watch: true, ctl }); this.sendWs(ws, this.snapshot(null)); this.broadcast(); return;
    }
    if (m.t === 'join') {
      let p = m.pid && s.players[m.pid] ? s.players[m.pid] : null;   // 斷線重連：用舊的通行碼拿回原本的位置
      if (!p) {
        if (s.phase !== 'lobby') { this.sendWs(ws, { t: 'error', code: 'started' }); return; }
        const used = Object.values(s.players).map((q) => q.slot), slot = SEATS[s.kind].find((i) => !used.includes(i));
        if (slot === undefined) { this.sendWs(ws, { t: 'error', code: 'full' }); return; }
        const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        p = s.players[pid] = { pid, slot, name: cleanName(m.name), avatar: String(m.avatar || '').slice(0, 24), input: m.input === 'motion' ? 'motion' : 'tap', ready: false, gone: false, dc: 0 };
        if (!s.host && !s.hk) s.host = pid;   // 電腦建的房間沒有玩家房主
      } else { p.dc = 0; p.gone = false; if (m.name) p.name = cleanName(m.name); if (m.avatar) p.avatar = String(m.avatar).slice(0, 24); if (m.input) p.input = m.input === 'motion' ? 'motion' : 'tap'; }
      for (const w of this.sockets()) { if (w !== ws && this.att(w).pid === p.pid) { try { w.close(1000, 'replaced'); } catch (e) {} } }   // 同一個人開了新連線：舊連線關掉
      ws.serializeAttachment({ pid: p.pid });
      this.sendWs(ws, { t: 'welcome', pid: p.pid, slot: p.slot });
      await this.save(); this.broadcast(); return;
    }
    // 大廳選項：房主（玩家）或電腦主持人
    const isHost = (a.pid && s.host === a.pid) || (a.watch && a.ctl);
    if (m.t === 'set' && s.phase === 'lobby' && isHost) {
      const ps = Object.values(s.players);
      if (KINDS.includes(m.kind) && m.kind !== s.kind) {
        if (m.kind === '1v1' && ps.length > 2) { this.sendWs(ws, { t: 'error', code: 'too_many' }); }
        else { s.kind = m.kind; ps.forEach((q, i) => { q.slot = SEATS[s.kind][i]; }); }
      }
      if (PACES.includes(m.pace)) s.pace = m.pace;
      if (RULES.includes(m.rule)) s.rule = m.rule;
      ps.forEach((q) => { q.ready = false; });
      await this.save(); this.broadcast(); return;
    }
    if (a.watch) return;   // 觀戰者送來的其他訊息一律忽略
    const me = this.byPid(a.pid); if (!me) return;
    if (m.t === 'profile') { if (m.name) me.name = cleanName(m.name); if (m.avatar) me.avatar = String(m.avatar).slice(0, 24); if (m.input) me.input = m.input === 'motion' ? 'motion' : 'tap'; await this.save(); this.broadcast(); return; }
    if (m.t === 'leave') { if (s.phase === 'lobby') { delete s.players[me.pid]; if (s.host === me.pid) s.host = Object.keys(s.players)[0] || null; } else { me.gone = true; me.dc = Date.now(); this.autoSkip(); } try { ws.close(1000, 'bye'); } catch (e) {} await this.save(); this.broadcast(); return; }
    if (m.t === 'ready' && s.phase === 'lobby') { me.ready = !!m.ready; if (this.allReady()) this.startGame(); await this.save(); this.broadcast(); return; }
    if (m.t === 'rematch' && s.phase === 'end') {
      s.phase = 'lobby'; s.g = null; s.result = null; s.startAt = 0;
      for (const [pid, q] of Object.entries(s.players)) { q.ready = false; if (q.gone || !this.isConnected(pid)) delete s.players[pid]; }
      if (!s.hk && !s.players[s.host]) s.host = Object.keys(s.players)[0] || null;
      ps_reslot(this); await this.save(); this.broadcast(); return;
    }
    if (s.phase !== 'play' || !s.g) return;
    const g = s.g, now = Date.now();
    if (m.t === 'lock') {   // 分工合投：定仰角與力道的那位，把數值交給隊友
      const u = g.units[m.u | 0]; if (!u || g.reveal) return; const i = m.i | 0, r = this.roles(u, i);
      if (i !== u.done || r.lock !== me.slot || !(m.e >= 0 && m.e <= 1 && m.p >= 0 && m.p <= 1)) return;
      u.lock = { i, e: +m.e, p: +m.p }; this.sendSlot(r.thrower, { t: 'lock', u: u.id, i, e: u.lock.e, p: u.lock.p });
      if (s.pace === 'turn') g.turnAt = now; await this.save(); this.toWatchers({ t: 'locked', u: u.id, i }); return;
    }
    if (m.t === 'ev') {
      const u = g.units[m.u | 0]; if (!u || g.reveal || now < s.startAt - 500) return; const i = m.i | 0, r = this.roles(u, i);
      if (i !== u.done || r.thrower !== me.slot || !PTS.hasOwnProperty(m.kind) || i >= need(g.round)) return;
      if (s.pace === 'turn') { const q = g.queue[g.tp]; if (!q || q[0] !== u.id || q[1] !== i) return; }
      this.record(u, i, m.kind, PTS[m.kind]); g.lastEv = now;
      const rep = Array.isArray(m.rep) && m.rep.length <= 1500 ? m.rep.map((n) => n | 0) : null;
      this.toAll({ t: 'ev', u: u.id, i, slot: me.slot, kind: m.kind, pts: PTS[m.kind], rep }, me.slot);   // 發送者自己不用收重播
      if (s.pace === 'turn') { g.wait = { slot: me.slot, acks: [], until: now + this.cfg.ACK_WAIT }; if (!this.waitingFor().length) this.advanceTurn(); } else this.checkBarrier();
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'ack' && s.pace === 'turn' && g.wait) { if (!g.wait.acks.includes(me.slot)) g.wait.acks.push(me.slot); if (!this.waitingFor().length) { this.advanceTurn(); } await this.save(); this.broadcast(); return; }
  }
  toWatchers(obj) { const t = JSON.stringify(obj); for (const w of this.watchers()) { try { w.send(t); } catch (e) {} } }

  async webSocketClose(ws) {
    if (!this.s) return; const a = this.att(ws); this.closing = ws;
    if (a.pid && this.byPid(a.pid)) {
      const p = this.byPid(a.pid);
      if (this.s.phase === 'lobby') { if (!this.isConnected(p.pid)) { p.dc = Date.now(); } } else if (!this.isConnected(p.pid)) p.dc = Date.now();
    }
    await this.save(); this.broadcast(); this.closing = null;
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  // 掉線太久的玩家：大廳直接讓出位置；遊戲中標記離場，輪到他的矢一律記 skip，剩下的人繼續
  autoSkip() {
    const s = this.s, g = s.g; if (s.phase !== 'play' || !g) return;
    if (g.reveal) return;
    if (s.pace === 'sync') { for (const u of g.units) if (!this.unitAlive(u)) while (u.done < need(g.round)) this.record(u, u.done, 'skip', 0); this.checkBarrier(); }
    else { this.skipDeadTurns(); if (g.queue && g.tp >= g.queue.length) this.beginReveal(); else if (g.queue && g.tp < g.queue.length) { const [id, i] = g.queue[g.tp], u = g.units[id], r = this.roles(u, i); if (!this.alive(r.thrower)) { this.record(u, i, 'skip', 0); this.advanceTurn(); } } }
  }
  async schedule() {
    const s = this.s; if (!s) return; let at = s.touched + IDLE_MS;
    for (const p of Object.values(s.players)) if (p.dc && !p.gone) at = Math.min(at, p.dc + this.cfg.DC_GRACE);
    const g = s.g; if (g) { if (g.reveal) at = Math.min(at, g.reveal.until); if (g.wait) at = Math.min(at, g.wait.until); if (s.pace === 'turn' && g.queue && !g.reveal && g.tp < g.queue.length) at = Math.min(at, g.turnAt + this.cfg.STALL); if (s.pace === 'sync' && s.phase === 'play' && !g.reveal) at = Math.min(at, g.lastEv + this.cfg.SYNC_STALL); }
    await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 200));
  }
  async alarm() {
    const s = this.s; if (!s) return; const now = Date.now();
    if (now - s.touched > IDLE_MS) { for (const w of this.sockets()) { try { w.close(1000, 'idle'); } catch (e) {} } await this.ctx.storage.deleteAll(); this.s = null; return; }
    let changed = false;
    for (const [pid, p] of Object.entries(s.players)) {
      if (p.dc && !p.gone && !this.isConnected(pid) && now - p.dc >= this.cfg.DC_GRACE) {
        changed = true;
        if (s.phase === 'lobby') { delete s.players[pid]; if (s.host === pid) s.host = Object.keys(s.players)[0] || null; } else { p.gone = true; }
      } else if (p.dc && this.isConnected(pid)) p.dc = 0;
    }
    const g = s.g;
    if (s.phase === 'play' && g) {
      if (g.reveal && now >= g.reveal.until) { this.nextRound(); changed = true; }
      else if (s.pace === 'turn' && g.wait && now >= g.wait.until) { this.advanceTurn(); changed = true; }
      else if (s.pace === 'turn' && g.queue && !g.reveal && g.tp < g.queue.length && now - g.turnAt >= this.cfg.STALL) {   // 輪到的人太久沒投：這一矢記 skip
        const [id, i] = g.queue[g.tp]; this.record(g.units[id], i, 'skip', 0); this.advanceTurn(); changed = true;
      }
      this.autoSkip();
      if (s.pace === 'sync' && !g.reveal && now - g.lastEv >= this.cfg.SYNC_STALL) {   // 同場：大家都在線卻太久沒動靜，沒投完的記 skip，讓遊戲繼續
        for (const u of g.units) while (u.done < need(g.round)) this.record(u, u.done, 'skip', 0);
        g.lastEv = now; this.checkBarrier(); changed = true;
      }
    }
    if (changed) { await this.save(); this.broadcast(); } else await this.schedule();
  }
}
function ps_reslot(room) { const s = room.s; Object.values(s.players).forEach((q, i) => { q.slot = SEATS[s.kind][i]; }); }
