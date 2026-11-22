// 全真群島・LINE 登入與紀錄同步（手機端）
// - 不登入照樣能玩，紀錄存在這支手機；登入後把手機上的紀錄和雲端合併（規則見 account-merge.js）
// - 開頁、每 45 秒（有變動才送）、離開頁面時各同步一次；雲端有這支手機沒有的紀錄時，存進手機後重新整理一次頁面
import { SYNC_KEYS, mergeSnap, canon } from './account-merge.js';

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const ACCOUNT_API = new URLSearchParams(location.search).get('acctapi') || (LOCAL ? 'http://localhost:8788' : 'https://islands-account.yiguandao2027.workers.dev');
const AKEY = 'islands-account';   // {t: 登入憑證, nm: LINE 名字（只存在這支手機，顯示用）, at: 上次同步時間}；不參與同步

const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
const readAcct = () => { try { const o = JSON.parse(ls.get(AKEY) || 'null'); return o && o.t ? o : null; } catch (e) { return null; } };
const writeAcct = (o) => (o ? ls.set(AKEY, JSON.stringify(o)) : ls.del(AKEY));
const snapLocal = () => { const o = {}; for (const k of SYNC_KEYS) { const v = ls.get(k); if (v == null) continue; try { o[k] = JSON.parse(v); } catch (e) {} } return o; };

const listeners = new Set();
let state = { acct: readAcct(), busy: false, msg: '' };
const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((f) => { try { f(state); } catch (e) {} }); };
export const onAccount = (f) => { listeners.add(f); f(state); return () => listeners.delete(f); };
export const accountState = () => state;

export function loginLine() {
  const ret = location.href.split('#')[0];
  location.href = ACCOUNT_API + '/auth/line/start?return=' + encodeURIComponent(ret);
}
export function logout() { writeAcct(null); emit({ acct: null, msg: '已登出。紀錄仍留在這支手機上。' }); }

async function post(path, body, keepalive = false) {
  const r = await fetch(ACCOUNT_API + path, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), keepalive, credentials: 'omit' });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401) { writeAcct(null); emit({ acct: null, msg: '登入已過期，請重新用 LINE 登入。' }); throw new Error('auth'); }
  if (!r.ok) throw new Error(j.error || 'http' + r.status);
  return j;
}

let lastSent = '', timer = 0;
// apply=true：雲端有新東西就存進手機並重新整理（只在開頁時這樣做，玩到一半不打斷）
export async function syncNow({ apply = false, quiet = false } = {}) {
  const a = readAcct(); if (!a || state.busy) return;
  emit({ busy: true, msg: quiet ? state.msg : '同步中…' });
  try {
    const local = snapLocal(), j = await post('/api/sync', { t: a.t, data: local });
    lastSent = canon(local);
    const merged = mergeSnap(local, j.data || {}), changed = SYNC_KEYS.filter((k) => merged[k] !== undefined && canon(merged[k]) !== canon(local[k]));
    const na = { ...a, at: Date.now() }; writeAcct(na);
    if (apply && changed.length) {
      changed.forEach((k) => ls.set(k, JSON.stringify(merged[k])));
      let n = 0; try { n = +sessionStorage.getItem('islands-acct-reload') || 0; sessionStorage.setItem('islands-acct-reload', n + 1); } catch (e) {}
      if (n < 2) { emit({ acct: na, busy: false, msg: '☁️ 取回雲端的紀錄，重新整理中…' }); setTimeout(() => location.reload(), 900); return; }
    }
    try { sessionStorage.removeItem('islands-acct-reload'); } catch (e) {}
    emit({ acct: na, busy: false, msg: quiet ? state.msg : '✅ 已同步' });
  } catch (e) {
    emit({ busy: false, msg: e.message === 'auth' ? state.msg : '⚠️ 同步失敗（網路不穩），稍後會自動再試' });
  }
}
export async function deleteCloud() {
  const a = readAcct(); if (!a) return false;
  await post('/api/delete', { t: a.t }); writeAcct(null);
  emit({ acct: null, msg: '🗑️ 雲端紀錄已刪除，也已登出。這支手機上的紀錄還在。' }); return true;
}

// 從 LINE 登入回來：網址 # 後面帶著登入憑證，存起來後把網址清乾淨
function takeHash() {
  const raw = window.__acctHash || location.hash; window.__acctHash = '';   // 頁面最前面可能已經先收起來（見 index.html <head>）
  if (!/(^#|&)(acct|acct_err)=/.test(raw)) return false;
  const h = new URLSearchParams(raw.slice(1)), t = h.get('acct'), err = h.get('acct_err');
  if (/(^#|&)(acct|acct_err)=/.test(location.hash)) history.replaceState(null, '', location.href.split('#')[0]);
  if (t) { writeAcct({ t, nm: (h.get('nm') || '').slice(0, 40), at: 0 }); emit({ acct: readAcct(), msg: '✅ 已用 LINE 登入' }); return true; }
  emit({ msg: { cancel: '已取消 LINE 登入。', expired: '登入花太久了，請再按一次「用 LINE 登入」。' }[err] || 'LINE 登入沒有成功，請稍後再試。' });
  return false;
}

export function initAccount() {
  const fresh = takeHash();
  if (readAcct()) setTimeout(() => syncNow({ apply: true, quiet: !fresh }), fresh ? 0 : 1200);
  clearInterval(timer);
  timer = setInterval(() => { if (readAcct() && !document.hidden && canon(snapLocal()) !== lastSent) syncNow({ quiet: true }); }, 45e3);
  const flush = () => { const a = readAcct(); if (!a) return; const local = snapLocal(), c = canon(local); if (c === lastSent) return; lastSent = c; post('/api/sync', { t: a.t, data: local }, true).catch(() => {}); };
  addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  addEventListener('pagehide', flush);
}
