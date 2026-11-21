/* 拂塵試煉・雙人對戰：房間伺服器
   - 一個房間 = 一個 Durable Object（名字就是 5 碼房號），用 WebSocket 連線，使用休眠 API（沒人說話時不計時）
   - 動作辨識在各自手機上做，伺服器只管：房號、誰在房裡、難度、準備、同一個隨機種子、倒數開始時間、心燈與分數、勝負
   - 訊息都很小；只存暱稱，不存任何個資；房間閒置 30 分鐘自動清掉 */
import { DurableObject } from 'cloudflare:workers';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 I、O、0、1
const CODE_LEN = 5, MAX_PLAYERS = 2, IDLE_MS = 30 * 60 * 1000, DC_GRACE_MS = 15 * 1000, COUNTDOWN_MS = 4500, GAME_MS = 120 * 1000, END_GRACE_MS = 6000;
const LIVES = { easy: 3, normal: 3, hard: 2 };
const FAMS = ['se', 'sheng', 'xiang', 'wei', 'chu', 'fa'];
const cors = (env, req) => { const o = req.headers.get('Origin') || '', ok = allowed(env, o); return { 'Access-Control-Allow-Origin': ok ? o : 'null', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }; };
const allowed = (env, origin) => !!origin && String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin);
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
const genCode = () => { const b = crypto.getRandomValues(new Uint8Array(CODE_LEN)); return [...b].map(x => ALPHABET[x % ALPHABET.length]).join(''); };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10) || '無名氏';

export default {
  async fetch(req, env) {
    const url = new URL(req.url), c = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    const m = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{3,8})(\/ws|\/info)?$/);
    if (url.pathname === '/api/create' && req.method === 'POST') {
      for (let i = 0; i < 8; i++) {
        const code = genCode(), stub = env.ROOMS.get(env.ROOMS.idFromName(code)), r = await stub.fetch('https://room/init', { method: 'POST' });
        if (r.status === 200) return json({ code }, 200, c);
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
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'fuchen-versus' }, 200, c);
    return json({ error: 'not_found' }, 404, c);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = null; ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get('s')) || null; }); }
  async save() { await this.ctx.storage.put('s', this.s); await this.schedule(); }
  newState() { return { phase: 'lobby', host: null, diff: 'easy', seed: 0, startAt: 0, endAt: 0, result: null, players: {}, touched: Date.now() }; }
  slotsUsed() { return Object.values(this.s.players).map(p => p.slot); }
  byPid(pid) { return this.s.players[pid] || null; }
  bySlot(slot) { return Object.values(this.s.players).find(p => p.slot === slot) || null; }
  liveSockets() { return this.ctx.getWebSockets(); }
  isConnected(pid) { return this.liveSockets().some(w => w !== this.closing && (() => { try { return (w.deserializeAttachment() || {}).pid === pid; } catch (e) { return false; } })()); }   // closing：正在關閉的連線不算

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') { if (this.s) return new Response('exists', { status: 409 }); this.s = this.newState(); await this.save(); return new Response('ok'); }
    if (!this.s) return json({ exists: false }, 404);
    if (url.pathname === '/info') { const n = Object.keys(this.s.players).length; return json({ exists: true, phase: this.s.phase, players: n, full: n >= MAX_PLAYERS && this.s.phase !== 'lobby' ? true : n >= MAX_PLAYERS, diff: this.s.diff }); }
    if (url.pathname === '/ws') { const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); return new Response(null, { status: 101, webSocket: pair[0] }); }
    return new Response('not found', { status: 404 });
  }

  // —— 給每個人的快照（不含別人的通行碼）——
  snapshot(forPid) {
    const s = this.s, me = this.byPid(forPid);
    return { t: 'state', you: me ? me.slot : -1, host: s.host ? (this.byPid(s.host) || {}).slot ?? -1 : -1, phase: s.phase, diff: s.diff, seed: s.seed, startAt: s.startAt, endAt: s.endAt, now: Date.now(), result: s.result,
      players: [0, 1].map(i => { const p = this.bySlot(i); return p ? { slot: i, name: p.name, avatar: p.avatar, ready: p.ready, lives: p.lives, score: p.score, hits: p.hits, combo: p.maxCombo, last: p.last, alive: p.alive, online: this.isConnected(p.pid) } : null; }) };
  }
  broadcast() { for (const w of this.liveSockets()) { try { const a = w.deserializeAttachment() || {}; w.send(JSON.stringify(this.snapshot(a.pid))); } catch (e) {} } }
  sendTo(slot, obj) { const p = this.bySlot(slot); if (!p) return; for (const w of this.liveSockets()) { try { if ((w.deserializeAttachment() || {}).pid === p.pid) w.send(JSON.stringify(obj)); } catch (e) {} } }

  async webSocketMessage(ws, raw) {
    if (!this.s) { ws.close(1011, 'no room'); return; }
    if (typeof raw !== 'string' || raw.length > 2000) { ws.close(1009, 'too big'); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {}, s = this.s; s.touched = Date.now();
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() })); return; }
    if (m.t === 'join') {
      let p = m.pid && s.players[m.pid] ? s.players[m.pid] : null;   // 斷線重連：用舊的通行碼拿回原本的位置
      if (!p) {
        if (s.phase !== 'lobby') { ws.send(JSON.stringify({ t: 'error', code: 'started' })); return; }
        const used = this.slotsUsed(), slot = [0, 1].find(i => !used.includes(i));
        if (slot === undefined) { ws.send(JSON.stringify({ t: 'error', code: 'full' })); return; }
        const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        p = s.players[pid] = { pid, slot, name: cleanName(m.name), avatar: String(m.avatar || '').slice(0, 24), ready: false, lives: LIVES[s.diff], score: 0, hits: 0, maxCombo: 0, last: '', alive: true, dc: 0 };
        if (!s.host) s.host = pid;
      } else { p.dc = 0; if (m.name) p.name = cleanName(m.name); if (m.avatar) p.avatar = String(m.avatar).slice(0, 24); }
      // 同一個人開了新連線：舊連線關掉
      for (const w of this.liveSockets()) { if (w !== ws && (w.deserializeAttachment() || {}).pid === p.pid) { try { w.close(1000, 'replaced'); } catch (e) {} } }
      ws.serializeAttachment({ pid: p.pid });
      ws.send(JSON.stringify({ t: 'welcome', pid: p.pid, slot: p.slot, code: undefined }));
      await this.save(); this.broadcast(); return;
    }
    const p = a.pid ? this.byPid(a.pid) : null; if (!p) return;
    if (m.t === 'set' && s.phase === 'lobby' && s.host === p.pid) {
      if (LIVES[m.diff]) { s.diff = m.diff; for (const q of Object.values(s.players)) { q.ready = false; q.lives = LIVES[s.diff]; } }
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'profile' && s.phase === 'lobby') { if (m.name) p.name = cleanName(m.name); if (m.avatar) p.avatar = String(m.avatar).slice(0, 24); await this.save(); this.broadcast(); return; }
    if (m.t === 'ready' && s.phase === 'lobby') {
      p.ready = !!m.ready; const ps = Object.values(s.players);
      if (ps.length === MAX_PLAYERS && ps.every(q => q.ready && this.isConnected(q.pid))) {
        s.phase = 'playing'; s.seed = crypto.getRandomValues(new Uint32Array(1))[0]; s.startAt = Date.now() + COUNTDOWN_MS; s.endAt = s.startAt + (Number(this.env.GAME_MS) || GAME_MS);   // GAME_MS 只給測試縮短時間用 s.result = null;
        for (const q of ps) { q.lives = LIVES[s.diff]; q.score = 0; q.hits = 0; q.maxCombo = 0; q.last = ''; q.alive = true; }
      }
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'ev' && s.phase === 'playing' && Date.now() >= s.startAt - 500 && p.alive) {
      // 簡單的合理性檢查：心燈只會減、分數只會加、單次加分有上限
      const lives = Math.max(0, Math.min(p.lives, Number(m.lives) | 0)), score = Math.max(p.score, Math.min(p.score + 600, Number(m.score) | 0));
      p.lives = lives; p.score = score; p.hits = Math.max(p.hits, Math.min(999, Number(m.hits) | 0)); p.maxCombo = Math.max(p.maxCombo, Math.min(99, Number(m.combo) | 0));
      const stage = Math.max(1, Math.min(3, Number(m.stage) | 0)), multi = !!m.multi, fam = FAMS.includes(m.fam) ? m.fam : 'se';
      p.last = m.ok ? (multi ? '連擊淨化' : stage === 3 ? '淨化塵魔' : stage === 2 ? '淨化塵妖' : '淨化塵精') : '被塵靈抓到';
      if (m.ok && (stage >= 2 || multi)) { const opp = Object.values(s.players).find(q => q.pid !== p.pid); if (opp) this.sendTo(opp.slot, { t: 'fx', from: p.slot, fam, stage, multi }); }
      if (p.lives <= 0) p.alive = false;
      const alive = Object.values(s.players).filter(q => q.alive);
      if (alive.length <= 1) await this.finish(alive.length === 1 ? 'knockout' : 'both_out'); else { await this.save(); this.broadcast(); }
      return;
    }
    if (m.t === 'timeup' && s.phase === 'playing' && Date.now() >= s.endAt - 1500) { await this.finish('time'); return; }   // 用戶端的時鐘到了就請伺服器結算（伺服器自己的鬧鐘是備援）
    if (m.t === 'rematch' && s.phase === 'done') {
      s.phase = 'lobby'; s.result = null; s.seed = 0; s.startAt = 0; s.endAt = 0; for (const q of Object.values(s.players)) { q.ready = false; q.lives = LIVES[s.diff]; q.score = 0; q.hits = 0; q.maxCombo = 0; q.last = ''; q.alive = true; }
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'leave') { await this.removePlayer(p.pid, 'left'); try { ws.close(1000, 'bye'); } catch (e) {} return; }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {}; const p = a.pid && this.s ? this.byPid(a.pid) : null;
    this.closing = ws;
    try { if (p && !this.isConnected(p.pid)) { p.dc = Date.now(); await this.save(); this.broadcast(); } } finally { this.closing = null; }
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  isConnectedExcept(pid, except) { return this.liveSockets().some(w => w !== except && (() => { try { return (w.deserializeAttachment() || {}).pid === pid; } catch (e) { return false; } })()); }

  async removePlayer(pid, why) {
    const s = this.s, p = s.players[pid]; if (!p) return;
    if (s.phase === 'playing') { p.alive = false; delete s.players[pid]; s.host = s.host === pid ? (Object.keys(s.players)[0] || null) : s.host; await this.finish(why === 'left' ? 'forfeit' : 'disconnect', pid); return; }
    delete s.players[pid]; if (s.host === pid) s.host = Object.keys(s.players)[0] || null;
    for (const q of Object.values(s.players)) q.ready = false;
    await this.save(); this.broadcast();
  }

  // 結算：只剩一人活著＝他贏；時間到＝比分數，再比心燈，都一樣就平手
  async finish(reason, leaverPid) {
    const s = this.s; if (s.phase !== 'playing') return;
    const ps = Object.values(s.players); let winner = -1;
    if (reason === 'forfeit' || reason === 'disconnect') winner = ps.length ? ps[0].slot : -1;
    else if (reason === 'knockout') { const w = ps.find(q => q.alive); winner = w ? w.slot : -1; }
    else { const [x, y] = [this.bySlot(0), this.bySlot(1)]; if (x && y) { winner = x.score !== y.score ? (x.score > y.score ? 0 : 1) : x.lives !== y.lives ? (x.lives > y.lives ? 0 : 1) : -1; } }
    s.phase = 'done'; s.result = { winner, reason, players: [0, 1].map(i => { const q = this.bySlot(i); return q ? { slot: i, name: q.name, score: q.score, lives: q.lives, hits: q.hits, combo: q.maxCombo } : null; }) };
    await this.save(); this.broadcast();
  }

  // —— 鬧鐘：時間到結算、斷線超過寬限就視為離場、閒置太久清掉房間 ——
  async schedule() {
    const s = this.s; if (!s) return; const times = [s.touched + IDLE_MS];
    if (s.phase === 'playing') times.push(s.endAt + END_GRACE_MS);
    for (const p of Object.values(s.players)) if (p.dc) times.push(p.dc + DC_GRACE_MS);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 200, Math.min(...times)));
  }
  async alarm() {
    const s = this.s; if (!s) return; const now = Date.now();
    if (now - s.touched >= IDLE_MS) { for (const w of this.liveSockets()) { try { w.close(1000, 'idle'); } catch (e) {} } await this.ctx.storage.deleteAll(); this.s = null; return; }
    if (s.phase === 'playing' && now >= s.endAt) { await this.finish('time'); }
    for (const p of Object.values(s.players)) if (p.dc && now - p.dc >= DC_GRACE_MS && !this.isConnected(p.pid)) { await this.removePlayer(p.pid, 'disconnect'); }
    await this.schedule();
  }
}
