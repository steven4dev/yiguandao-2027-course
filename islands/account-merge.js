// 全真群島・帳號同步的「合併規則」：手機（islands/account.js）和帳號伺服器（account-worker）共用同一份
// 原則：兩邊各自拿到的東西都保留（徽章、籤、金句、圖鑑取聯集），分數取高的，解鎖日期取早的；
// 格式看不懂的那一份就丟掉，不會把好的紀錄蓋壞。

const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
const str = (x, n = 200) => (typeof x === 'string' ? x.slice(0, n) : '');
const earlier = (a, b) => (a == null ? b : b == null ? a : (typeof a === typeof b ? (a <= b ? a : b) : a));
const maxN = (a, b) => { const x = num(a), y = num(b); return x == null ? y : y == null ? x : Math.max(x, y); };
const unionArr = (a, b, lim = 400) => [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, lim);
// 「拿過的 id → 第一次拿到的日期」：聯集，日期取早的
const gotMerge = (a, b, lim = 500) => { const o = {}; for (const src of [a, b]) if (isObj(src)) for (const [k, v] of Object.entries(src)) { if (Object.keys(o).length >= lim && !(k in o)) continue; if (typeof v === 'string' || typeof v === 'number') o[k] = earlier(o[k], v); } return o; };
// 今天抽到哪一支：以日期比較新的那一份為準
const todayMerge = (r, a, b) => { const da = str(a.day, 20), db = str(b.day, 20); const w = db > da ? b : a; r.day = str(w.day, 20); r.today = num(w.today) || 0; };

export const SYNC_RULES = {
  // 徽章：got＝徽章 id → 解鎖時間（毫秒），seen＝逛過哪些地方，days＝有上島的日子
  'islands-badges': { ok: (o) => isObj(o) && o.v === 1, strip: ({ fresh, ...o }) => o, merge(a, b) {   // fresh（新徽章小紅點）只留在各自的手機
    const seen = {}; for (const src of [a.seen, b.seen]) if (isObj(src)) for (const [k, v] of Object.entries(src)) seen[k] = unionArr(seen[k], v, 300);
    return { ...a, v: 1, got: gotMerge(a.got, b.got), seen, days: unionArr(a.days, b.days, 1000).sort() };
  } },
  // 求籤島籤冊、菩提島菩提冊
  'islands-jishi': { ok: (o) => isObj(o) && o.v === 2, merge(a, b) { const r = { ...a, v: 2, got: gotMerge(a.got, b.got) }; todayMerge(r, a, b); return r; } },
  'islands-puti': { ok: (o) => isObj(o) && o.v === 1, merge(a, b) { const r = { ...a, v: 1, got: gotMerge(a.got, b.got) }; todayMerge(r, a, b); return r; } },
  // 廚神養成島：主廚名字、每道菜最高分、第幾期；封面圖片太大，只留在手機上（不上傳）
  'islands-chef': { ok: (o) => isObj(o) && o.v === 1, strip: (o) => ({ ...o, covers: [] }), merge(a, b) {
    const best = {}; for (const src of [a.best, b.best]) if (isObj(src)) for (const [k, v] of Object.entries(src)) { const m = maxN(best[k], v); if (m != null) best[k] = m; }
    return { ...a, v: 1, name: str(a.name, 40) || str(b.name, 40), best, issue: maxN(a.issue, b.issue) || 0, covers: Array.isArray(a.covers) ? a.covers : [] };
  } },
  // 拂塵試煉：最高分、塵魔圖鑑
  'fuchenGame.best': { ok: (o) => num(o) != null, merge: (a, b) => maxN(a, b) },
  'fuchenGame.dex': { ok: (o) => isObj(o) && isObj(o.m), merge(a, b) {
    const m = {}; for (const src of [a.m, b.m]) for (const [k, v] of Object.entries(src || {})) { if (!isObj(v)) continue; const e = m[k] || {};
      m[k] = { ...e, n: maxN(e.n, v.n) || 0, first: e.first || str(v.first, 30) }; if (e.gold || v.gold) m[k].gold = true; if (e.hard || v.hard) m[k].hard = true; }
    return { ...a, v: 1, m };
  } },
  // 投壺島：最高分、玩過幾場、累計入壺與貫耳、投過幾矢，都取較大值（兩邊各自累計，沒辦法相加，相加會重複算）；
  // 暱稱、操作方式、左右對調只留在手機，不上傳
  'islands-touhu': { ok: (o) => isObj(o) && o.v === 1, strip: ({ nick, nickCustom, mode, flipX, ...o }) => o, merge(a, b) {
    const r = { ...a, v: 1 }; for (const k of ['best', 'plays', 'ins', 'ears', 'throws']) r[k] = maxN(a[k], b[k]) || 0; return r;
  } },
  // 自己寫過的瓶中信、祈福卡（本來就是公開貼出去的內容）：用時間戳記去重，留最近 20 封
  'islands-mybottles': { ok: (o) => Array.isArray(o), merge(a, b) {
    const by = new Map(); for (const x of [...a, ...b]) if (isObj(x) && num(x.ts) != null && !by.has(x.ts)) by.set(x.ts, x);
    return [...by.values()].sort((x, y) => x.ts - y.ts).slice(-20);
  } },
};
export const SYNC_KEYS = Object.keys(SYNC_RULES);

// 合併兩份快照（{key: 值}）：a 是「這一邊」，b 是「另一邊」；只看得懂的格式才合併
export function mergeSnap(a, b) {
  const out = {};
  for (const k of SYNC_KEYS) {
    const R = SYNC_RULES[k], x = a && R.ok(a[k]) ? a[k] : undefined, y = b && R.ok(b[k]) ? b[k] : undefined;
    if (x === undefined && y === undefined) continue;
    out[k] = x === undefined ? y : y === undefined ? x : R.merge(x, y);
  }
  return out;
}
// 上傳前拿掉只留在手機上的部分（例如廚神封面圖片）
export function stripSnap(s) { const o = {}; for (const [k, v] of Object.entries(s || {})) { const R = SYNC_RULES[k]; if (R && R.ok(v)) o[k] = R.strip ? R.strip(v) : v; } return o; }
// 比較用：鍵排序後的 JSON
export function canon(v) { return JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x)); }
