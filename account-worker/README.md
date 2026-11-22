# 全真群島・帳號伺服器（LINE 登入＋紀錄同步）

Cloudflare Worker + Durable Objects。網址：`https://islands-account.yiguandao2027.workers.dev`（2026/11/22 部署）。
一個帳號＝一個 Durable Object，裡面只存一份合併後的紀錄快照。

## 隱私原則
- 只申請 LINE 的 `openid profile`，**不拿 email**。
- LINE 的使用者代號用 `UID_KEY` 做 HMAC，變成匿名編號，伺服器只認這個編號。
- LINE 名字不存：登入當下放在網址 `#` 後面交給手機顯示。
- 同步哪些紀錄、怎麼合併，看 `islands/account-merge.js`（手機和伺服器共用同一份）。廚神島封面圖片不上傳。

## 流程
1. 手機按「用 LINE 登入」，前往 `GET /auth/line/start?return=<群島網址>`，再轉到 LINE 授權頁（PKCE，state 是簽過名的小憑證，10 分鐘內有效）。
2. LINE 轉回 `GET /auth/line/callback`。伺服器用 Channel secret 換 id_token，再到 LINE 的 verify API 驗證，接著發一張 180 天的登入憑證。
3. 轉回群島網址 `#acct=<憑證>&nm=<名字>`。島嶼頁 `<head>` 最前面就把它收起來、清掉網址（不讓造訪統計讀到）。
4. `islands/account.js` 在三個時間點同步：開頁時；每 45 秒，有變動才送；離開頁面時。

| API（POST，內容是純文字 JSON） | 說明 |
|---|---|
| `/api/sync {t, data}` | 上傳手機快照，伺服器合併後存起來，回傳合併結果 `{data, updated}` |
| `/api/delete {t}` | 永久刪除這個帳號的雲端紀錄 |
| `GET /health` | `{ok, line: 有沒有填 Channel secret, keys}` |

## 機密（不寫在 wrangler.toml）
- `LINE_CHANNEL_SECRET`：LINE Developers 後台 → Channel → Basic settings 的 Channel secret。**本人到 Cloudflare 後台填**：
  Workers & Pages → islands-account → Settings → Variables and Secrets → Add → Type 選 Secret，名稱 `LINE_CHANNEL_SECRET`，值貼上 → Deploy。
- `SESSION_KEY`：簽登入憑證。已隨機產生；更換後大家要重新登入。
- `UID_KEY`：轉換匿名編號。已隨機產生。**永遠不要換**，換了所有人的紀錄都會對不上。

## 本機測試
```bash
cd account-worker
printf 'SESSION_KEY=test-session-key-local\nUID_KEY=test-uid-key-local\nLINE_CHANNEL_SECRET=dummy\n' > .dev.vars
npx wrangler dev --port 8788 --local
node test/account.test.mjs     # 23 項：登入跳轉、state 防偽、401/403/413、合併規則、帳號隔離、刪除
```
群島在 `localhost` 打開時會自動連 `http://localhost:8788`。

## 部署
`npx wrangler deploy`（需要 Workers 編輯權限的 API 金鑰）。

## 開放給所有人
1. LINE Developers 後台把 Channel 從 Developing 改成 **Published**。Developing 狀態下只有管理者和測試者登得進去。
2. 後台的 Privacy policy URL 填 `https://steven4dev.github.io/yiguandao-2027-course/islands/privacy.html`。
3. `islands/index.html` 搜尋 `const ACCT_LIVE`，改成 `true`。在那之前，只有用 `?acct=1` 打開過群島的手機看得到登入按鈕（`?acct=0` 取消）。
