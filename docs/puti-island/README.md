# 清淨菩提島（雲開見日洲）・React／R3F 參考版

> 真正上線的是原生 Three.js 版，寫在 `islands/index.html`（變數、函式都用 `PT`／`pt` 開頭），跟群島其他島一樣不需要建置。
> 這個資料夾是同一套邏輯的 React／React Three Fiber 版，給日後群島搬到 React 時直接沿用；演算法、shader、門檻數值兩邊一致。
> TypeScript 型別檢查通過（react 18.3、@react-three/fiber 8.17、three 0.160）。

## 互動流程（狀態機）

```
idle ──開始──▶ askMic ──允許麥克風──▶ blowing（先量 0.8 秒底噪，再累積 progress 0→100）──滿──▶ cleared ──收起金句──▶ idle（今天已雲開）
                 │                         ▲
                 └──拒絕／LINE 內建瀏覽器／沒有麥克風／自己選──▶ blowing（按住吹氣）
任何進行中的狀態 ──點別座島、關資訊卡、切到背景──▶ idle（馬上關麥克風）
```

| 需求裡的旗標 | 對應 |
|---|---|
| `isMicReady` | `phase === 'blowing' && mode === 'mic'` |
| `isBlowing` | `useBlowDetection().isBlowing` |
| `isCleared` | `phase === 'cleared'`，或今天已經雲開過（`todayQuote != null`） |

## 檔案（UI 層與 Canvas 層分離）

```
src/
  types/quote.ts            BodhiQuote 介面、BodhiRecord（菩提冊）、JSON Schema
  data/quotes.mock.ts       示範金句 8 句（第 1 句是企劃範例；上線前換成道場審定的慈語）
  hooks/useBlowDetection.ts 麥克風吹氣偵測：AudioContext、AnalyserNode、底噪校正、平坦度、門檻、progress、cleanup
  machine/putiMachine.ts    useReducer 狀態機、抽金句（優先給還沒拿過的）
  scene/                    ── Canvas 層（只吃 ref，每一幀在 useFrame 更新，不觸發 React 重畫）
    FogParticles.tsx        雲霧粒子（自訂 ShaderMaterial）：progress → 擴散半徑＋透明度，gust → 即時翻湧
    PureLotus.tsx           清淨蓮花：bloom 0→1 含苞到綻放、發光
    WisdomStele.tsx         智慧石碑：灰色刻字，reveal 0→1 金字浮現
    PutiCanvas.tsx          組合場景、光柱
  ui/PutiPanel.tsx          ── UI 層（DOM）：步驟、麥克風提示、音量條＋門檻線、進度條、按住吹氣、上方金句面板
  PutiIsland.tsx            把狀態機、偵測、Canvas、UI 接起來；「叮～」法音
```

## 吹氣怎麼判斷

每一幀從 `AnalyserNode`（fftSize 1024）取三個特徵：

1. **整體音量 rmsDb**：要比底噪大 `margin`（14 dB）以上，而且至少 `absMin`（-52 dBFS）。底噪＝開麥克風後 0.8 秒的第 25 百分位（略過剛打開時的全零訊號），之後安靜時慢慢跟著環境調整。
2. **頻譜平坦度 flatness**（150–4000 Hz，幾何平均÷算術平均）：吹氣是寬頻雜訊，實測 0.25～0.45；說話、唱歌有諧波，實測 0.001～0.02。門檻 0.2。
3. **低頻占比 lowShare**（600 Hz 以下 ÷ 60–6000 Hz）：嘴巴對著麥克風吹，風切聲集中在低頻；「嘶～」這類高頻氣音不算。門檻 0.35。非常大聲（≥ -24 dBFS）時平坦度門檻放寬到 0.1。

三個條件連續成立 140 ms 才算開始吹，中斷 220 ms 才算停（濾掉拍手、敲桌）。吹的時候 progress 依力道累積（約 3.2 秒吹滿），停下超過 0.8 秒每秒退 8%。所有門檻集中在原生版的 `QT`、hook 的 `DEFAULTS`。

用 Chromium 假麥克風實測：模擬吹氣的音檔會被判斷成吹氣，大約 3 秒吹滿；模擬說話（有顫音、語調起伏）的音檔 progress 一直是 0，畫面提示「聽起來像說話聲」。真實手機還是要實際試吹，再微調門檻。

## 平台注意事項

- `getUserMedia` 要關掉 `noiseSuppression`、`echoCancellation`、`autoGainControl`，不然瀏覽器會把風聲當雜訊濾掉。
- iOS Safari 17+：開麥克風前把 `navigator.audioSession.type` 設成 `'play-and-record'`，關掉後改回 `'playback'`（群島預設是 `playback`，靜音鍵打開時也聽得到音樂）。
- 開麥克風期間，背景音樂和音效要先淡出：喇叭的聲音會被麥克風收進去，干擾判斷。「叮～」等麥克風關好之後再敲。
- LINE、Facebook 內建瀏覽器常常拿不到麥克風 → 改用按住吹氣，並提示「用預設瀏覽器開啟」。
- 必須是 https（GitHub Pages 沒問題）；本機測試用 `localhost`。
- 計時用 `performance.now()` 的真實時間，不用被截短的 frame dt，手機卡頓時秒數才準。
- 系統設定「減少動態效果」時，雲霧照樣會散開，只是不飄動、不翻湧。
