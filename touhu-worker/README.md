# 投壺島・多人對戰 房間伺服器

Cloudflare Worker + Durable Objects。一個房間＝一個 Durable Object（名字就是 5 碼房號），用 WebSocket 連線，使用休眠 API（沒人說話時不計時）。
遊戲前端（`islands/touhu-game/index.html`）的「多人對戰」會連到這裡。**還沒部署前，正式網站上看不到「多人對戰」按鈕**（頁面載入時先打 `/health`，連不上就不顯示）。
獨立於拂塵試煉的 `mp-worker/`（`fuchen-versus`），兩個服務互不影響。

## 玩法與規則
- **對戰類型 `kind`**：`1v1`（2 人）、`2v2`（4 人，座位 0、1＝紅隊，2、3＝藍隊，依加入順序 0、2、1、3 排，兩隊人數一樣多）。
- **節奏 `pace`**：
  - `sync` 同場對投：各投各的、同一組風；每個單位這輪 4 矢都投完才一起對帳（顯示本輪結算，各自看對方最精彩的一矢重播）。
  - `turn` 輪流對投：一人一矢，輪到誰誰投，其他人看他的重播；重播看完（都送 `ack`）或等太久（`ACK_WAIT_MS`）就換下一位。
- **2v2 規則 `rule`**：
  - `split` 分工合投：每個隊伍是一個計分單位。第 `i` 矢由 `members[i%2]` 定仰角與力道（送 `lock`），另一位定左右並放箭（送 `ev`），每矢互換；隊友離場後剩下的人包辦。
  - `sum` 各自累計：四位各是一個單位，隊伍分數是兩人相加。
- **計分**：入壺 2、貫耳 3、沒進 0（離場或太久沒動靜記 `skip`＝0）。三輪、每輪每單位 4 矢，三輪後同分就**加賽**：每單位 1 矢，最多 3 次，還是同分算平手。
- **風**：由房間種子（`state.seed`）加上輪次與矢序，手機各自用同一個函式產生，雙方這一矢的風向風力一樣。壺在第三輪的搖晃是手機本地時間決定的，不同步（算「浪的運氣」）。
- 動作與物理都在各自手機上跑，**伺服器不驗證物理**（只驗順序、角色、分數與種類是否合法），適合朋友之間切磋，不是防作弊。

## 通訊協定（JSON，小訊息；`ev` 的重播軌跡最多 1500 個整數）
| 方向 | 訊息 | 說明 |
|---|---|---|
| → | `join {pid?, name, avatar?, input}` | 進房；重連時帶回通行碼 `pid` 拿回原位置。`input` 是 `tap` 或 `motion`（只供顯示） |
| → | `join {watch:true, hk?}` | 觀戰（大螢幕），不佔位置、最多 8 個；帶對主持金鑰 `hk` 就是電腦主持人 |
| → | `set {kind?, pace?, rule?}` | 大廳選項：玩家房主或電腦主持人；換類型時依加入順序重排座位，所有人取消準備 |
| → | `profile {name?, avatar?, input?}` | 改暱稱、操作方式 |
| → | `ready {ready}` | 準備／取消；人數到齊且全部準備就開打（倒數 `COUNTDOWN_MS`） |
| → | `lock {u, i, e, p}` | 分工合投：定仰角 `e`、力道 `p`（0～1）的那位，把數值交給隊友 |
| → | `ev {u, i, kind, rep?}` | 放箭的人回報第 `u` 單位第 `i` 矢的結果（`in`／`ear`／`miss`）與重播軌跡 |
| → | `ack {u, i}` | 輪流：我看完這一矢的重播了 |
| → | `rematch` / `leave` / `ping {c}` | 再來一局（回大廳）、離開、校時 |
| ← | `welcome {pid, slot}` / `state {...}` / `ev {u, i, slot, kind, pts, rep}` / `lock {u, i, e, p}` / `pong` / `error {code}` | 快照、別人的結果與重播（發送者自己不會收到）、隊友鎖定的數值、錯誤（`full`／`started`／`too_many`／`watch_full`） |

HTTP：`POST /api/create` 建房 → `{code}`；body 帶 `{"host":true}`（電腦建房）會多回一把 `hk` 主持金鑰。`GET /api/room/<房號>` 查房；`GET /api/room/<房號>/ws` 升級成 WebSocket（只接受 `ALLOWED_ORIGINS` 裡的網頁來源）。

## 重播軌跡
手機每 0.05 模擬秒記一次矢尖的位置與壺的位置（公分整數），一矢約 1～3 KB；對方用慢動作（`REP_RATE`）依序播放，最後轉成最終的矢尖朝向。比兩邊各自重新模擬穩，因為物理步進本身不是逐位元一致。

## 斷線與離場
- 掉線寬限 `DC_GRACE_MS`（預設 20 秒）內，用通行碼重連拿回原位（遊戲進行中也可以，頁面重新整理會自動重連）。
- 超過寬限：大廳直接讓出位置；遊戲中標記離場，輪到他的矢一律記 `skip`，其他人繼續；分工合投的隊友離場後，剩下的人一個人定三項。
- 同場對投有人連著線卻一直不投，`SYNC_STALL_MS`（預設 3 分鐘）後沒投完的記 `skip`；輪流對投輪到的人 `STALL_MS`（預設 70 秒）沒動靜就記 `skip`。

## 本機測試（不需要 Cloudflare 帳號）
```bash
cd touhu-worker
npm install
# 用縮短的計時器啟動（測試專用）：
npx wrangler dev --local --port 8787 --var COUNTDOWN_MS:300 --var REVEAL_MS:700 --var TURN_REVEAL_MS:300 --var ACK_WAIT_MS:600 --var STALL_MS:3000 --var SYNC_STALL_MS:4000 --var DC_GRACE_MS:1500
node test/touhu.test.mjs     # 約 45 項檢查：1v1 同場／輪流、2v2 分工／累計、平手加賽、斷線重連與離場、電腦主持權限、重賽
```
遊戲在本機測試：先 `python3 -m http.server 8765`（在專案根目錄），再打開 `http://localhost:8765/islands/touhu-game/?mp=http://localhost:8787`（`?mp=` 指定房間伺服器位址；`?norender` 只跑邏輯不繪圖，給自動測試用；`?room=ABCDE` 帶房號進加入畫面；`?host=1` 用電腦主持）。

## 部署（需要 Cloudflare 帳號，請本人操作或授權）
1. `cd touhu-worker && npm install && npx wrangler login`（或設好有 Workers 編輯權限的 API 金鑰）。
2. `npx wrangler deploy`，成功後網址應該是 `https://touhu-room.<帳號子網域>.workers.dev`（拂塵與帳號伺服器用的子網域是 `yiguandao2027`，這個服務會落在同一個子網域，遊戲前端的 `MP_API` 預設就是這個）。
3. 確認 `wrangler.toml` 的 `ALLOWED_ORIGINS` 有正式網站網址（預設已含 `https://steven4dev.github.io`）。
4. 打開 `https://steven4dev.github.io/yiguandao-2027-course/islands/touhu-game/`，首頁出現「👥 多人對戰」就是連上了。

> 費用與額度：Durable Objects 與 Worker 有免費方案，但額度與條件會變動，部署前請到 Cloudflare 官方說明確認目前的規定（本專案開發時無法連上官方文件，未能核對）。
