/* 拂塵試煉・雙人對戰：房間伺服器
   - 一個房間 = 一個 Durable Object（名字就是 5 碼房號），用 WebSocket 連線，使用休眠 API（沒人說話時不計時）
   - 動作辨識在各自手機上做，伺服器只管：房號、誰在房裡、難度、準備、同一個隨機種子、倒數開始時間、心燈與分數、勝負
   - 訊息都很小；只存暱稱，不存任何個資；房間閒置 30 分鐘自動清掉 */
import { DurableObject } from 'cloudflare:workers';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 I、O、0、1
const CODE_LEN = 5, MAX_PLAYERS = 2, MAX_WATCHERS = 8, IDLE_MS = 30 * 60 * 1000, DC_GRACE_MS = 15 * 1000, COUNTDOWN_MS = 4500, GAME_MS = 120 * 1000, END_GRACE_MS = 6000;
const LIVES = { easy: 3, normal: 3, hard: 2 };
// 2 對 2 合作：座位 0、1 是紅隊，2、3 是藍隊；加入順序依 SEAT_ORDER 排（紅1、藍1、紅2、藍2），兩隊人數一樣多
const MAXP = { duo: 2, team: 4 }, SEAT_ORDER = { duo: [0, 1], team: [0, 2, 1, 3] };
const TEAM_LIVES = { easy: 4, normal: 4, hard: 3 }, STAGE_PTS = { 1: 100, 2: 140, 3: 200 }, CUE_MS = 2800, STALL_MS = 14000, JOINT_WAIT_MS = 9000;
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
      // 電腦建房（host:true）：多給一把「主持金鑰」，拿著它的觀戰畫面可以設定難度；這種房間的玩家沒有房主，開打由兩位玩家都按準備決定
      let body = {}; try { const t = await req.text(); if (t && t.length < 500) body = JSON.parse(t) || {}; } catch (e) {}
      const hk = body.host === true ? [...crypto.getRandomValues(new Uint8Array(12))].map(x => ALPHABET[x % ALPHABET.length]).join('') : null;
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
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'fuchen-versus' }, 200, c);
    return json({ error: 'not_found' }, 404, c);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.s = null; ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get('s')) || null; }); }
  async save() { await this.ctx.storage.put('s', this.s); await this.schedule(); }
  newState(hk) { return { hk: hk || null, mode: 'duo', teams: null, phase: 'lobby', host: null, diff: 'easy', seed: 0, startAt: 0, endAt: 0, result: null, players: {}, touched: Date.now() }; }
  slotsUsed() { return Object.values(this.s.players).map(p => p.slot); }
  byPid(pid) { return this.s.players[pid] || null; }
  bySlot(slot) { return Object.values(this.s.players).find(p => p.slot === slot) || null; }
  maxP() { return MAXP[this.s.mode] || 2; }
  teamPublic() { return this.s.mode === 'team' && this.s.teams ? this.s.teams.map(t => ({ score: t.score, lives: t.lives, n: t.n, s: t.s, k: t.k, stage: t.stage, combo: t.combo, hits: t.hits, lastOk: t.lastOk, lastN: t.lastN, lastPts: t.lastPts, lastK: t.lastK, cueAt: t.cueAt, solo: t.solo, alive: t.alive, rep: Object.keys(t.rep).map(Number) })) : null; }
  // 這一步輪到誰（座位）：第 s 步由 (n+s)%2 那位揮，三招的第 3 步兩人一起；隊友不在了就剩下的人包辦
  actorsOf(t, ti) { const sl = [ti * 2, ti * 2 + 1]; if (t.solo >= 0) return [t.solo]; if (t.s === 2) return sl; return [sl[(t.n + t.s) % 2]]; }
  liveSockets() { return this.ctx.getWebSockets(); }
  isConnected(pid) { return this.liveSockets().some(w => w !== this.closing && (() => { try { return (w.deserializeAttachment() || {}).pid === pid; } catch (e) { return false; } })()); }   // closing：正在關閉的連線不算

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') { if (this.s) return new Response('exists', { status: 409 }); let b = {}; try { b = await req.json(); } catch (e) {} this.s = this.newState(typeof b.hk === 'string' ? b.hk.slice(0, 24) : null); await this.save(); return new Response('ok'); }
    if (!this.s) return json({ exists: false }, 404);
    if (url.pathname === '/info') { const n = Object.keys(this.s.players).length; return json({ exists: true, phase: this.s.phase, players: n, cx: !!this.s.hk, mode: this.s.mode, full: n >= this.maxP(), diff: this.s.diff }); }
    if (url.pathname === '/ws') { const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]); return new Response(null, { status: 101, webSocket: pair[0] }); }
    return new Response('not found', { status: 404 });
  }

  // —— 給每個人的快照（不含別人的通行碼）——
  snapshot(forPid) {
    const s = this.s, me = this.byPid(forPid);
    return { t: 'state', cx: !!s.hk, mode: s.mode, teams: this.teamPublic(), you: me ? me.slot : -1, host: s.host ? (this.byPid(s.host) || {}).slot ?? -1 : -1, phase: s.phase, diff: s.diff, seed: s.seed, startAt: s.startAt, endAt: s.endAt, now: Date.now(), result: s.result,
      players: Array.from({ length: this.maxP() }, (_, i) => i).map(i => { const p = this.bySlot(i); return p ? { team: s.mode === 'team' ? i >> 1 : null, slot: i, name: p.name, avatar: p.avatar, ready: p.ready, lives: p.lives, score: p.score, hits: p.hits, combo: p.maxCombo, last: p.last, alive: p.alive, cur: p.cur || null, online: this.isConnected(p.pid) } : null; }), watchers: this.watchers().length };
  }
  broadcast() { for (const w of this.liveSockets()) { try { const a = w.deserializeAttachment() || {}; w.send(JSON.stringify(this.snapshot(a.pid))); } catch (e) {} } }
  watchers() { return this.liveSockets().filter(w => { try { return (w.deserializeAttachment() || {}).watch === true; } catch (e) { return false; } }); }
  toWatchers(obj) { const t = JSON.stringify(obj); for (const w of this.watchers()) { try { w.send(t); } catch (e) {} } }
  sendTo(slot, obj) { const p = this.bySlot(slot); if (!p) return; for (const w of this.liveSockets()) { try { if ((w.deserializeAttachment() || {}).pid === p.pid) w.send(JSON.stringify(obj)); } catch (e) {} } }

  async webSocketMessage(ws, raw) {
    if (!this.s) { ws.close(1011, 'no room'); return; }
    if (typeof raw !== 'string' || raw.length > 2000) { ws.close(1009, 'too big'); return; }
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const a = ws.deserializeAttachment() || {}, s = this.s; s.touched = Date.now();
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() })); return; }
    if (m.t === 'join' && m.watch) {   // 觀戰：不佔玩家位置、不能操作，只收廣播
      if (this.watchers().filter(w => w !== ws).length >= MAX_WATCHERS) { ws.send(JSON.stringify({ t: 'error', code: 'watch_full' })); return; }
      const ctl = !!(s.hk && typeof m.hk === 'string' && m.hk === s.hk);   // 持有主持金鑰的觀戰畫面＝電腦主持人
      ws.serializeAttachment({ watch: true, ctl }); ws.send(JSON.stringify({ t: 'welcome', watch: true, ctl })); ws.send(JSON.stringify(this.snapshot(null))); this.broadcast(); return;
    }
    if (m.t === 'join') {
      let p = m.pid && s.players[m.pid] ? s.players[m.pid] : null;   // 斷線重連：用舊的通行碼拿回原本的位置
      if (!p) {
        if (s.phase !== 'lobby') { ws.send(JSON.stringify({ t: 'error', code: 'started' })); return; }
        const used = this.slotsUsed(), slot = SEAT_ORDER[s.mode].find(i => !used.includes(i));
        if (slot === undefined) { ws.send(JSON.stringify({ t: 'error', code: 'full' })); return; }
        const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
        p = s.players[pid] = { pid, slot, name: cleanName(m.name), avatar: String(m.avatar || '').slice(0, 24), ready: false, lives: LIVES[s.diff], score: 0, hits: 0, maxCombo: 0, last: '', alive: true, dc: 0 };
        if (!s.host && !s.hk) s.host = pid;   // 電腦建的房間沒有玩家房主
      } else { p.dc = 0; if (m.name) p.name = cleanName(m.name); if (m.avatar) p.avatar = String(m.avatar).slice(0, 24); }
      // 同一個人開了新連線：舊連線關掉
      for (const w of this.liveSockets()) { if (w !== ws && (w.deserializeAttachment() || {}).pid === p.pid) { try { w.close(1000, 'replaced'); } catch (e) {} } }
      ws.serializeAttachment({ pid: p.pid });
      ws.send(JSON.stringify({ t: 'welcome', pid: p.pid, slot: p.slot, code: undefined }));
      await this.save(); this.broadcast(); return;
    }
    if (a.watch) {   // 觀戰者送來的訊息一律忽略；只有電腦主持人可以在大廳設定難度
      if (a.ctl && m.t === 'set' && s.phase === 'lobby') {
        if (LIVES[m.diff]) { s.diff = m.diff; for (const q of Object.values(s.players)) { q.ready = false; q.lives = LIVES[s.diff]; } }
        if (m.mode === 'duo' || m.mode === 'team') {   // 換模式：依加入順序重新排座位；改成 1 對 1 時超過 2 人不能換
          const ps = Object.values(s.players);
          if (m.mode === 'duo' && ps.length > 2) ws.send(JSON.stringify({ t: 'error', code: 'too_many' }));
          else { s.mode = m.mode; ps.forEach((q, i) => { q.slot = SEAT_ORDER[s.mode][i]; q.ready = false; }); }
        }
        await this.save(); this.broadcast();
      }
      return;
    }
    const p = a.pid ? this.byPid(a.pid) : null; if (!p) return;
    if (m.t === 'set' && s.phase === 'lobby' && s.host === p.pid) {
      if (LIVES[m.diff]) { s.diff = m.diff; for (const q of Object.values(s.players)) { q.ready = false; q.lives = LIVES[s.diff]; } }
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'profile' && s.phase === 'lobby') { if (m.name) p.name = cleanName(m.name); if (m.avatar) p.avatar = String(m.avatar).slice(0, 24); await this.save(); this.broadcast(); return; }
    if (m.t === 'ready' && s.phase === 'lobby') {
      p.ready = !!m.ready; const ps = Object.values(s.players);
      if (ps.length === this.maxP() && ps.every(q => q.ready && this.isConnected(q.pid))) {
        s.phase = 'playing'; s.seed = crypto.getRandomValues(new Uint32Array(1))[0]; s.startAt = Date.now() + COUNTDOWN_MS; s.endAt = s.startAt + (Number(this.env.GAME_MS) || GAME_MS);   // GAME_MS 只給測試縮短時間用 s.result = null;
        for (const q of ps) { q.lives = LIVES[s.diff]; q.score = 0; q.hits = 0; q.maxCombo = 0; q.last = ''; q.alive = true; q.cur = null; }
        s.teams = s.mode === 'team' ? [0, 1].map(() => ({ score: 0, lives: TEAM_LIVES[s.diff], n: 0, s: 0, k: 0, stage: 1, fam: 'se', combo: 0, maxCombo: 0, hits: 0, lastOk: null, lastN: -1, lastPts: 0, lastK: 0, rep: {}, stepAt: s.startAt, cueAt: 0, solo: -1, alive: true })) : null;
      }
      await this.save(); this.broadcast(); return;
    }
    if (m.t === 'path' && s.phase === 'playing' && p.alive) {   // 玩家每一揮的路徑（最多 3 揮、每揮 40 點）：檢查格式後只轉給觀戰者
      const clean = v => Array.isArray(v) ? v.slice(0, 40).filter(q => Array.isArray(q) && q.length === 2).map(q => [Math.max(-150, Math.min(150, Number(q[0]) | 0)), Math.max(-150, Math.min(150, Number(q[1]) | 0))]) : null;
      const paths = Array.isArray(m.paths) ? m.paths.slice(0, 3).map(clean) : [], ok = Array.isArray(m.ok) ? m.ok.slice(0, 3).map(Boolean) : [], why = Array.isArray(m.why) ? m.why.slice(0, 3).map(w => String(w || '').slice(0, 12)) : [];
      const keys = Array.isArray(m.keys) ? m.keys.slice(0, 3).map(k => String(k || '').slice(0, 8)) : [];
      this.toWatchers({ t: 'path', slot: p.slot, paths, ok, why, keys }); return;
    }
    if (m.t === 'cur' && s.mode !== 'team' && s.phase === 'playing' && p.alive) { p.cur = { n: Math.max(0, Math.min(999, Number(m.n) | 0)), at: Date.now() }; this.toWatchers({ t: 'cur', slot: p.slot, n: p.cur.n }); return; }
    if (m.t === 'step') { await this.onStep(p, m); return; }
    if (m.t === 'stall') { await this.onStall(p, m); return; }
    if (m.t === 'ev' && s.mode !== 'team' && s.phase === 'playing' && Date.now() >= s.startAt - 500 && p.alive) {
      // 簡單的合理性檢查：心燈只會減、分數只會加、單次加分有上限
      const lives = Math.max(0, Math.min(p.lives, Number(m.lives) | 0)), score = Math.max(p.score, Math.min(p.score + 600, Number(m.score) | 0));
      p.lives = lives; p.score = score; p.hits = Math.max(p.hits, Math.min(999, Number(m.hits) | 0)); p.maxCombo = Math.max(p.maxCombo, Math.min(99, Number(m.combo) | 0));
      const stage = Math.max(1, Math.min(3, Number(m.stage) | 0)), multi = !!m.multi, fam = FAMS.includes(m.fam) ? m.fam : 'se';
      p.last = m.ok ? (multi ? '連擊淨化' : stage === 3 ? '淨化塵魔' : stage === 2 ? '淨化塵妖' : '淨化塵精') : '被塵靈抓到';
      this.toWatchers({ t: 'evx', slot: p.slot, ok: !!m.ok, stage, multi, fam, lives: p.lives });
      if (m.ok && (stage >= 2 || multi)) { const opp = Object.values(s.players).find(q => q.pid !== p.pid); const fx = { t: 'fx', from: p.slot, fam, stage, multi }; if (opp) this.sendTo(opp.slot, fx); this.toWatchers(fx); }
      if (p.lives <= 0) p.alive = false;
      const alive = Object.values(s.players).filter(q => q.alive);
      if (alive.length <= 1) await this.finish(alive.length === 1 ? 'knockout' : 'both_out'); else { await this.save(); this.broadcast(); }
      return;
    }
    if (m.t === 'timeup' && s.phase === 'playing' && Date.now() >= s.endAt - 1500) { await this.finish('time'); return; }   // 用戶端的時鐘到了就請伺服器結算（伺服器自己的鬧鐘是備援）
    if (m.t === 'rematch' && s.phase === 'done') {
      s.phase = 'lobby'; s.result = null; s.teams = null; s.seed = 0; s.startAt = 0; s.endAt = 0; for (const q of Object.values(s.players)) { q.ready = false; q.lives = LIVES[s.diff]; q.score = 0; q.hits = 0; q.maxCombo = 0; q.last = ''; q.alive = true; }
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
    if (s.phase === 'playing' && s.mode === 'team') { await this.removeTeamPlayer(pid, why); return; }
    if (s.phase === 'playing') { p.alive = false; delete s.players[pid]; s.host = s.host === pid ? (Object.keys(s.players)[0] || null) : s.host; await this.finish(why === 'left' ? 'forfeit' : 'disconnect', pid); return; }
    delete s.players[pid]; if (s.host === pid) s.host = Object.keys(s.players)[0] || null;
    for (const q of Object.values(s.players)) q.ready = false;
    await this.save(); this.broadcast();
  }

  // —— 2 對 2：一步一步的合作流程 ——
  // 手機各自判斷自己那一揮，回報 step {n, s, ok, k, stage, fam}；輪到兩個人的那一步要兩人都回報且都成功才算過
  async onStep(p, m) {
    const s = this.s; if (s.mode !== 'team' || s.phase !== 'playing' || !s.teams || Date.now() < s.startAt - 500) return;
    const ti = p.slot >> 1, t = s.teams[ti]; if (!t.alive || (m.n | 0) !== t.n || (m.s | 0) !== t.s) return;   // 過期的訊息直接忽略
    const need = this.actorsOf(t, ti); if (!need.includes(p.slot)) return;
    if (t.s === 0) { t.k = Math.max(1, Math.min(3, m.k | 0)); t.stage = Math.max(1, Math.min(3, m.stage | 0)); t.fam = FAMS.includes(m.fam) ? m.fam : 'se'; }
    if (!t.k) return;
    t.rep[p.slot] = !!m.ok; this.toWatchers({ t: 'tstep', team: ti, n: t.n, s: t.s, slot: p.slot, ok: !!m.ok, part: true });
    if (!need.every(sl => sl in t.rep)) { await this.save(); this.broadcast(); return; }
    await this.resolveStep(ti, need.every(sl => t.rep[sl]));
  }
  // 卡住了（隊友的手機沒動靜）：等的那一方可以請伺服器判這一步失敗
  async onStall(p, m) {
    const s = this.s; if (s.mode !== 'team' || s.phase !== 'playing' || !s.teams) return;
    const ti = p.slot >> 1, t = s.teams[ti]; if (!t.alive || (m.n | 0) !== t.n || (m.s | 0) !== t.s) return;
    if (Date.now() >= (t.cueAt ? t.cueAt + JOINT_WAIT_MS : t.stepAt + STALL_MS)) await this.resolveStep(ti, false);
  }
  async resolveStep(ti, ok) {
    const s = this.s, t = s.teams[ti], now = Date.now(), need = this.actorsOf(t, ti);
    this.toWatchers({ t: 'tstep', team: ti, n: t.n, s: t.s, ok, slots: need });
    if (ok && t.s + 1 < t.k) {   // 這一步過了，換下一步（第 3 步要兩人一起，先給大家一個同步的「揮」提示時間）
      t.s++; t.rep = {}; t.stepAt = now; t.cueAt = t.s === 2 && t.solo < 0 ? now + CUE_MS : 0; await this.save(); this.broadcast(); return;
    }
    const k = t.k, stage = t.stage, fam = t.fam; let pts = 0;
    if (ok) {
      t.combo++; t.maxCombo = Math.max(t.maxCombo, t.combo); t.hits++; pts = STAGE_PTS[stage] + 50 * (k - 1) + Math.min(t.combo - 1, 10) * 10; t.score += pts;
      const mates = [ti * 2, ti * 2 + 1].map(i => this.bySlot(i)).filter(Boolean);
      for (const q of mates) { q.score += Math.round(pts / mates.length); q.hits++; q.maxCombo = Math.max(q.maxCombo, t.combo); }
    } else { t.combo = 0; t.lives = Math.max(0, t.lives - 1); }
    t.lastOk = ok; t.lastN = t.n; t.lastPts = pts; t.lastK = k;
    t.n++; t.s = 0; t.k = 0; t.rep = {}; t.stepAt = now; t.cueAt = 0;
    this.toWatchers({ t: 'tdone', team: ti, n: t.lastN, ok, k, stage, fam, pts });
    if (ok && (stage >= 2 || k > 1)) { const fx = { t: 'fx', from: ti * 2, fam, stage, multi: k > 1 }; for (const i of [(1 - ti) * 2, (1 - ti) * 2 + 1]) this.sendTo(i, fx); this.toWatchers(fx); }
    if (t.lives <= 0) { t.alive = false; await this.finish('knockout'); return; }
    await this.save(); this.broadcast();
  }
  // 對戰中有人離開：隊友還在就由他一個人包辦所有步驟；整隊都沒人了就判輸
  async removeTeamPlayer(pid, why) {
    const s = this.s, p = s.players[pid], ti = p.slot >> 1, t = s.teams && s.teams[ti]; delete s.players[pid];
    const mate = this.bySlot(ti * 2 + (1 - (p.slot & 1)));
    if (t && mate) { t.solo = mate.slot; t.rep = {}; t.stepAt = Date.now(); t.cueAt = 0; await this.save(); this.broadcast(); return; }
    if (t) t.alive = false;
    await this.finish(why === 'left' ? 'forfeit' : 'disconnect');
  }

  // 結算：只剩一人活著＝他贏；時間到＝比分數，再比心燈，都一樣就平手
  async finish(reason, leaverPid) {
    const s = this.s; if (s.phase !== 'playing') return;
    if (s.mode === 'team' && s.teams) {
      const [a, b] = s.teams; let w = -1;
      if (reason === 'time') w = a.score !== b.score ? (a.score > b.score ? 0 : 1) : a.lives !== b.lives ? (a.lives > b.lives ? 0 : 1) : -1;
      else w = a.alive && !b.alive ? 0 : b.alive && !a.alive ? 1 : -1;
      s.phase = 'done'; s.result = { mode: 'team', winner: w, reason, teams: s.teams.map(t => ({ score: t.score, lives: t.lives, hits: t.hits, combo: t.maxCombo })), players: [0, 1, 2, 3].map(i => { const q = this.bySlot(i); return q ? { slot: i, team: i >> 1, name: q.name, score: q.score, hits: q.hits, combo: q.maxCombo } : null; }) };
      await this.save(); this.broadcast(); return;
    }
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
