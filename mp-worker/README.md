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
| → | `join {watch:true}` | 觀戰（投影用），不佔位置、最多 8 個，只收廣播 |
| → | `cur {n}` | 玩家開始打第幾隻（轉給觀戰者） |
| → | `path {paths, ok, why}` | 每一揮的路徑（最多 3 揮×40 點，-150～150 整數），只轉給觀戰者 |
| → | `set {diff}` | 房主改難度（easy／normal／hard） |
| → | `profile {name, avatar}` | 改暱稱、頭像 |
| → | `ready {ready}` | 準備／取消；兩人都準備就開打 |
| → | `ev {ok, stage, multi, fam, score, lives, hits, combo}` | 每打完一隻回報一次 |
| → | `timeup` / `rematch` / `leave` / `ping {c}` | 時間到、再來一局、離開、校時 |
| ← | `welcome {pid, slot}` / `state {...}` / `fx {from, fam, stage, multi}` / 觀戰者另收 `cur {slot, n}`、`evx {slot, ok, stage, multi, fam, lives}`、`path {slot, paths, ok, why}` / `pong {c, s}` / `error {code}` | 快照、干擾、校時、錯誤（full／started） |

HTTP：`POST /api/create` 建房 → `{code}`；body 帶 `{"host":true}`（電腦建房）會多回一把 `hk` 主持金鑰：觀戰時 `join {watch:true, hk}` 對上就是主持人（welcome 帶 `ctl:true`），可以在大廳送 `set {diff}`；這種房間的玩家沒有房主（state 的 `host` 是 -1、`cx` 是 true），難度只有主持人能改。`GET /api/room/<房號>` 查房；`GET /api/room/<房號>/ws` 升級成 WebSocket（只接受 `ALLOWED_ORIGINS` 裡的網頁來源）。

## 2 對 2 合作（電腦主持的房間）
- 主持人（持 `hk` 的觀戰連線）在大廳送 `set {mode:'duo'|'team'}`；`team` 有 4 個座位：0、1＝紅隊，2、3＝藍隊，加入順序依 0,2,1,3 排（兩隊人數一樣多）。換模式會依加入順序重排座位並清掉準備。
- 4 位都準備就開打，state 帶 `mode:'team'` 與 `teams:[{score,lives,n,s,k,stage,combo,hits,lastOk,lastN,lastPts,lastK,cueAt,solo,alive,rep}]`（n＝第幾隻、s＝第幾步、k＝這隻幾招、cueAt＝同步揮的時間、solo＝隊友離開後剩下的座位、rep＝這一步已回報的座位）。
- 一步由誰揮：`actorsOf`＝第 s 步 (n+s)%2 那位、第 3 步（s=2）兩人一起；隊友不在了（solo）就剩下的人。手機回報 `step {n,s,ok,k,stage,fam}`（第 0 步帶 k／stage／fam），兩人的那一步要兩人都回報且都成功；過期或不是你的步驟會被忽略。太久沒動靜可以送 `stall {n,s}`，超過 14 秒（兩人的那一步是 cue 後 9 秒）伺服器才會判這一步失敗。
- 一隻怪結束：成功＝隊伍分數 `STAGE_PTS[stage] + 50*(k-1) + 連擊加成（最多 100）`，平分給在場隊員；失敗＝全隊共用心燈 −1、連擊歸零。心燈 0＝整隊出局（`knockout`）。打中塵妖或連擊會對另一隊兩位送 `fx`。
- 觀戰者另收 `tstep {team,n,s,slot,ok,part}`、`tdone {team,n,ok,k,stage,fam,pts}`；玩家的 `path` 可帶 `keys`（這一揮的符印）。結算 `result.mode === 'team'`，帶 `teams` 與 4 位玩家的貢獻。
- 玩家離開或斷線超過寬限：隊友還在就 `solo`，整隊沒人就 `forfeit`／`disconnect` 判輸。

## 本機測試（不需要 Cloudflare 帳號）
```bash
cd mp-worker
npm install
npx wrangler dev --port 8787 --local --var GAME_MS:5000   # GAME_MS 只給測試縮短對戰時間
node test/versus.test.mjs                                  # 約 40 項檢查：建房、加入、同種子、事件、斷線重連、時間到、防護
```
遊戲在本機（`localhost`）會自動連 `http://localhost:8787`。

## 目前部署
- 網址：`https://fuchen-versus.yiguandao2027.workers.dev`（2026/11/21 部署，帳號子網域 yiguandao2027）。
- 重新部署（改了 `src/index.js` 之後）：`npx wrangler deploy`（需要有 Workers 編輯權限的 API 金鑰，或先 `npx wrangler login`）。
- 測線上版：`BASE=https://fuchen-versus.yiguandao2027.workers.dev node test/versus.test.mjs`（「時間到」那一段要等 2 分鐘，可先跳過）。

## 第一次部署（需要 Cloudflare 帳號，請本人操作）
1. 到 https://dash.cloudflare.com 註冊免費帳號。
2. `cd mp-worker && npm install && npx wrangler login`（瀏覽器登入授權）。
3. `npx wrangler deploy`，成功後會印出網址，長得像 `https://fuchen-versus.<你的子網域>.workers.dev`。
4. 把這個網址填進 `islands/fuchen-game/index.html` 的 `VS_API`（搜尋 `const VS_API`），並確認 `wrangler.toml` 的 `ALLOWED_ORIGINS` 有正式網站網址。
5. 先用 `?vs=<那個網址>` 在兩支手機上實測，沒問題再正式開放。

> 費用與額度：Durable Objects 與 Worker 有免費方案，但額度與條件會變動，部署前請到 Cloudflare 官方說明確認目前的規定（本專案開發時無法連上官方文件，未能核對）。
