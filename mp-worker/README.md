# 拂塵試煉・雙人對戰 房間伺服器

Cloudflare Worker + Durable Objects。一個房間＝一個 Durable Object（名字就是 5 碼房號），用 WebSocket 連線。
遊戲前端（`islands/fuchen-game/index.html`）的「雙人對戰」會連到這裡。**還沒部署前，正式網站上看不到對戰按鈕**（`VS_API` 是空的）。

## 它負責什麼、不負責什麼
- 負責：房號、誰在房裡、難度、準備、同一個隨機種子、倒數開始時間、心燈與分數、勝負、斷線重連。
- 不負責：動作辨識（在各自的手機上做，伺服器無法驗證），所以有簡單的合理性檢查（分數只增不減、單次加分有上限），但不是完整防作弊，適合朋友之間切磋。
- 只存暱稱，不存任何個資；房間閒置 30 分鐘自動清掉。

## 通訊協定（JSON，小訊息）
| 方向 | 訊息 | 說明 |
|---|---|---|
| → | `join {pid?, name, avatar}` | 進房；重連時帶回通行碼 `pid` 拿回原位置 |
| → | `set {diff}` | 房主改難度（easy／normal／hard） |
| → | `profile {name, avatar}` | 改暱稱、頭像 |
| → | `ready {ready}` | 準備／取消；兩人都準備就開打 |
| → | `ev {ok, stage, multi, fam, score, lives, hits, combo}` | 每打完一隻回報一次 |
| → | `timeup` / `rematch` / `leave` / `ping {c}` | 時間到、再來一局、離開、校時 |
| ← | `welcome {pid, slot}` / `state {...}` / `fx {from, fam, stage, multi}` / `pong {c, s}` / `error {code}` | 快照、干擾、校時、錯誤（full／started） |

HTTP：`POST /api/create` 建房 → `{code}`；`GET /api/room/<房號>` 查房；`GET /api/room/<房號>/ws` 升級成 WebSocket（只接受 `ALLOWED_ORIGINS` 裡的網頁來源）。

## 本機測試（不需要 Cloudflare 帳號）
```bash
cd mp-worker
npm install
npx wrangler dev --port 8787 --local --var GAME_MS:5000   # GAME_MS 只給測試縮短對戰時間
node test/versus.test.mjs                                  # 約 40 項檢查：建房、加入、同種子、事件、斷線重連、時間到、防護
```
遊戲在本機（`localhost`）會自動連 `http://localhost:8787`。

## 部署（需要 Cloudflare 帳號，請本人操作）
1. 到 https://dash.cloudflare.com 註冊免費帳號。
2. `cd mp-worker && npm install && npx wrangler login`（瀏覽器登入授權）。
3. `npx wrangler deploy`，成功後會印出網址，長得像 `https://fuchen-versus.<你的子網域>.workers.dev`。
4. 把這個網址填進 `islands/fuchen-game/index.html` 的 `VS_API`（搜尋 `const VS_API`），並確認 `wrangler.toml` 的 `ALLOWED_ORIGINS` 有正式網站網址。
5. 先用 `?vs=<那個網址>` 在兩支手機上實測，沒問題再正式開放。

> 費用與額度：Durable Objects 與 Worker 有免費方案，但額度與條件會變動，部署前請到 Cloudflare 官方說明確認目前的規定（本專案開發時無法連上官方文件，未能核對）。
