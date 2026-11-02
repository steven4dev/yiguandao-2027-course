# 濟世靈山島：濟公活佛體感抽籤系統（規劃與核心程式）

> 狀態：規劃稿＋核心模組（已通過 TypeScript 嚴格模式型別檢查、狀態機模擬測試），尚未接上群島。
> 技術：React 18 + React Three Fiber 8 + Three.js 0.160（與群島目前用的 Three 版本一致）。

## 一、島嶼造景（三區）

| 區域 | 3D 物件 | 對應互動階段 |
|---|---|---|
| 入口洗塵區 | 青石板路（InstancedMesh 鋪石）、竹林（Instanced 竹竿＋風擺 shader）、**葫蘆靈泉**（葫蘆口出水，水面用 `MeshPhysicalMaterial` + 法線貼圖捲動） | 階段一 淨手洗心 |
| 核心抽籤區 | **濟公草堂**（茅草頂、四柱）、中央石桌、**木造籤筒**、**破蒲扇**（隨搖晃能量擺動） | 階段二～四 |
| 解籤休憩區 | 聖訓碑廊（石碑上刻籤號）、許願樹（掛滿紅布條，抽到的籤號那條會亮） | 卷軸展開後鏡頭移過來 |

鏡頭依 `phase` 移動（`CameraRig`）：`purify` 看靈泉 → `permission/bow` 看草堂正面 → `shake/pour` 拉近籤筒 → `reading` 移到碑廊與許願樹。

## 二、資料夾結構

```
src/islands/jishi/
├─ JishiIsland.tsx            # 島嶼入口：<Canvas> + <LotteryHUD>，持有 useLotterySensors
├─ types/fortune.ts           # ✅ Fortune 介面＋JSON Schema
├─ data/fortunes.mock.ts      # ✅ 8 支示範籤（非師尊原文，上線前替換）
├─ machine/lotteryMachine.ts  # ✅ 狀態機 reducer（純函式）
├─ lib/
│  ├─ sensorMath.ts           # ✅ 低通濾波、遲滯＋持續時間防抖、冷卻、螢幕方向換算
│  └─ permissions.ts          # ✅ iOS requestPermission、感測器實際有無資料偵測
├─ hooks/
│  ├─ useLotterySensors.ts    # ✅ 主 Hook：狀態機＋陀螺儀＋加速度計＋震動
│  ├─ useLotteryAudio.ts      # ✅ Web Audio 合成：水流、竹籤碰撞、出籤鈴聲
│  └─ useRubGesture.ts        # ✅ 淨手摩擦 2 秒判斷
├─ scene/
│  ├─ JishiScene.tsx          # 燈光、霧、海面、島體
│  ├─ CameraRig.tsx           # 依 phase 移動鏡頭
│  ├─ zones/EntranceZone.tsx  # 青石板路、竹林
│  ├─ zones/GourdSpring.tsx   # 葫蘆靈泉（purifyProgress 越高水越清、越亮）
│  ├─ zones/StrawHall.tsx     # 草堂、石桌
│  ├─ FortuneTube.tsx         # ✅ 籤筒＋竹籤＋出籤動畫（感測器綁定示範）
│  ├─ BrokenFan.tsx           # 破蒲扇
│  └─ zones/TabletCorridor.tsx, WishingTree.tsx
└─ ui/
   ├─ LotteryHUD.tsx          # 依 phase 切換下面的提示元件
   ├─ PurifyPad.tsx           # 靈泉摩擦區（綁 useRubGesture）
   ├─ BowGuide.tsx            # 「請將手機直立貼近胸前」＋叩首 ○○○
   ├─ ShakeMeter.tsx          # 進度條＋「請保持直立」提示
   ├─ PourGuide.tsx           # 「將籤筒向前傾倒」
   ├─ FortuneScroll.tsx       # 2D 籤詩卷軸
   └─ FallbackControls.tsx    # 桌機／權限被拒時的按鈕模擬
```

✅ = 本次已實作，在 `docs/jishi-island/src/` 底下。

## 三、狀態機

```
purify ─PURIFY_DONE→ permission ─(點「開始參拜」= 請求權限)→ bow ─BOW×3→ ready
   ─(點「開始搖籤」)→ shake ─progress=100→ pour ─beta<45° 持續0.3秒→ drawn ─竹籤落地→ reading
```

- 規格中的旗標都保留在 state：`isPurified`、`isBowed`、`isShaking`、`progress`（0–100）、`isDrawn`，另有 `phase` 當唯一真相。
- 每個 action 只在所屬階段有效，其他階段收到一律忽略，所以不可能跳步驟。
- `RESET` 保留權限結果，再抽一次不必重新授權，但要重新淨手、參拜。

### ⚠️ 與原規格的一處調整：iOS 權限請求的時機

原規格寫「階段二完成時才觸發 `requestPermission`」，但階段二本身就要讀陀螺儀，所以權限一定要在叩首之前拿到。而且 iOS 規定只能在**使用者點擊**的當下同步呼叫。

所以改成兩個按鈕：
1. 淨手完成後出現「🙏 開始參拜」：點下去同時請求陀螺儀＋加速度計權限、解鎖音效。
2. 叩首三次後解鎖「🎋 開始搖籤」（就是規格裡的「解鎖抽籤按鈕」）。

## 四、感測器判斷與防手抖

| 階段 | 訊號 | 判斷 | 防抖做法 |
|---|---|---|---|
| 叩首 | `beta`（直立 ≈ 90°） | ≤ 55° 算拜下、≥ 75° 算回正，回正才算一叩 | 低通濾波 120ms；55–75° 是遲滯緩衝帶；兩邊都要維持 180ms；兩叩最少間隔 600ms；先確認有直立才開始數 |
| 搖晃 | `acceleration`（無重力）或 `accelerationIncludingGravity` 高通 | 力道 > 4 m/s² 開始累積；> 9 m/s² 的上升邊緣算一次竹籤碰撞 | 碰撞間隔隨搖晃速度從 160ms 縮到 55ms；降到 70% 以下才允許下一次；進度每 100ms 批次送進 reducer |
| 直立 | beta 60–120°、左右歪 ≤ 35° | 不直立時不累積進度、顯示提示 | 狀態改變要維持 300ms 才更新提示 |
| 出籤 | `beta` | < 45° 持續 300ms | 同上 |

所有門檻集中在 `DEFAULT_TUNING`，實機測試後只改這裡，也可以用 `tuning` 參數覆蓋。

裝置差異：
- iOS Safari 不支援 `navigator.vibrate`，已做功能偵測，iPhone 上只有聲音沒有震動。
- 必須 HTTPS（GitHub Pages 符合）。
- 授權後 1.2 秒內收不到數值（桌機、部分平板）→ 自動切 `fallbackMode`，改用按鈕模擬。
- 橫拿手機時有換算 beta／gamma，但接近直立時數值不穩，UI 仍建議直拿。

## 五、2D 感測器數據 → 3D 籤筒動畫的綁定要點

1. **高頻數值走 ref，不走 state。** 感測器每秒 60 次，放進 React state 會讓整棵樹每秒重繪 60 次。`useLotterySensors` 回傳的 `live` 是一個 ref，3D 元件在 `useFrame` 裡直接讀：
   ```tsx
   useFrame((_, delta) => {
     const L = live.current;
     tube.rotation.x = THREE.MathUtils.damp(tube.rotation.x, degToRad(90 - L.pitch), 6, delta);
   });
   ```
2. **只有換階段才走 props。** `phase`、`fortuneId` 一場只變幾次，當 props 傳下去沒問題。
3. **一律用 `damp` 追目標值**，不要直接把角度貼到模型上；`damp` 依 `delta` 計算，60Hz 跟 120Hz 螢幕的手感一樣。
4. **連續量 vs. 瞬間事件分開處理：**
   - 連續量（`pitch`、`shakeEnergy`）→ 對應到籤筒傾角、抖動幅度、破蒲扇擺動。
   - 瞬間事件（竹籤碰撞）→ 記下 `lastHitAt` 和力道，3D 端用 `intensity × exp(-經過時間 / 80ms)` 做衰減脈衝，竹籤「跳一下再落回」。
5. **大量竹籤用 `InstancedMesh`**，每幀 `setMatrixAt` 後設 `instanceMatrix.needsUpdate = true`，一次 draw call。
6. **出籤動畫分兩段座標系：** 滑出時竹籤在籤筒的區域座標（跟著筒傾斜）；滑出後用 `getWorldPosition/Quaternion` 換到世界座標，交給簡易重力＋彈跳落到石桌，落地後呼叫 `actions.stickLanded()` 展開卷軸（另有 3 秒保險計時器）。
7. **同一組數值可以驅動多個物件：** `bowLean` 可以讓場景裡的小人偶跟著鞠躬，`shakeEnergy` 同時驅動籤筒、破蒲扇、草堂風鈴，畫面更有整體感。

## 六、組裝範例

```tsx
export function JishiIsland() {
  const audio = useLotteryAudio();
  const { state, live, fortune, actions, simulate } = useLotterySensors({ audio, fortunes: MOCK_FORTUNES });
  const rub = useRubGesture({
    enabled: state.phase === 'purify',
    onStart: () => { audio.unlock(); audio.startWater(); },
    onStop: audio.stopWater,
    onProgress: actions.purifyProgress,
    onComplete: actions.purifyDone,
  });

  return (
    <>
      <Canvas shadows camera={{ position: [0, 2.2, 3.2], fov: 45 }}>
        <JishiScene purifyProgress={state.purifyProgress} />
        <FortuneTube phase={state.phase} live={live} fortuneId={state.fortuneId}
                     onLanded={actions.stickLanded} position={[0, 0.8, 0]} tableY={0.8} />
      </Canvas>
      {state.phase === 'purify' && <PurifyPad {...rub.bind} progress={state.purifyProgress} />}
      {state.phase === 'permission' && <button onClick={actions.beginBow}>🙏 開始參拜</button>}
      {state.phase === 'ready' && <button onClick={actions.startShake}>🎋 開始搖籤</button>}
      {state.fallbackMode && <FallbackControls phase={state.phase} {...simulate} />}
      {state.phase === 'reading' && fortune && <FortuneScroll fortune={fortune} onAgain={actions.reset} />}
    </>
  );
}
```

## 七、接回全真群島的方式（需要決定）

群島目前是 `islands/index.html` 單一檔案、原生 Three.js、**沒有建置流程**，React／R3F 不能直接放進去。兩條路：

- **A. 獨立子頁（建議）**：`islands/jishi/` 用 Vite 建置成靜態檔，群島的島嶼點擊後連過去（跟 `#bottle` 類似）。好處是群島主檔不用改架構；要加一個 GitHub Actions 建置步驟。
- **B. 移植成原生 JS**：狀態機、`sensorMath`、權限、音效、手勢判斷都不依賴 React，可以幾乎原封不動搬進 `islands/index.html`，只有 Hook 外殼和 R3F 元件要改寫成 `requestAnimationFrame` 版本。

## 八、籤詩內容

`data/fortunes.mock.ts` 的 8 支籤是**仿濟公老師口吻寫的示範文案，不是活佛師尊原文**。上線前請講師或點傳師以道場審定的慈語替換，並註明出處。分類目前是修心、人際、解憂、求職各 2 支。
