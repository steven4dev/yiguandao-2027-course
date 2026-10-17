/**
 * 法會小天使・體驗人次統計（Google 試算表 + Apps Script）
 *
 * 用法：在 Google 試算表的「擴充功能 → Apps Script」貼上這整段程式碼，
 * 部署成「網頁應用程式」（執行身分：我；誰可以存取：所有人），
 * 再把部署網址填到 game/stats-config.json 的 endpoint。
 *
 * 只記錄匿名事件：時間、事件（開始／完成／分享）、版本、模式、星等，不收集任何個人資料。
 */

const SHEET_NAME = '紀錄';
const EVENTS = ['start', 'finish', 'share'];
const LEVELS = ['mobile', 'desktop'];
const MODES = ['challenge', 'relax'];

// 網址沒帶參數：回傳統計總數（遊戲顯示「已有 N 人次」、GitHub 每日備份都讀這裡）
// 網址帶 action=hit：記一筆事件
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'hit') return json_(hit_(p));
  return json_(summary_());
}

function hit_(p) {
  const ev = String(p.ev || '');
  if (EVENTS.indexOf(ev) < 0) return { ok: false };
  const level = LEVELS.indexOf(p.level) >= 0 ? p.level : '';
  const mode = MODES.indexOf(p.mode) >= 0 ? p.mode : '';
  const stars = /^[0-3]$/.test(String(p.stars || '')) ? Number(p.stars) : '';
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet_().appendRow([new Date(), ev, level, mode, stars]);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('summary');
  return { ok: true };
}

function summary_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('summary');
  if (hit) return JSON.parse(hit);
  const sh = sheet_();
  const rows = Math.max(sh.getLastRow() - 1, 0);
  const out = { start: 0, finish: 0, share: 0, mobile: 0, desktop: 0, updated: new Date().toISOString() };
  if (rows) {
    sh.getRange(2, 2, rows, 2).getValues().forEach(function (r) {
      if (out[r[0]] !== undefined) out[r[0]]++;
      if (r[0] === 'finish' && out[r[1]] !== undefined) out[r[1]]++;
    });
  }
  cache.put('summary', JSON.stringify(out), 60);
  return out;
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['時間', '事件', '版本', '模式', '星等']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 在編輯器按「執行」測試用：會建立「紀錄」工作表並寫入一筆測試資料
function 測試() {
  Logger.log(hit_({ ev: 'start', level: 'mobile', mode: 'relax' }));
  Logger.log(summary_());
}
