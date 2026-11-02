import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { initialLotteryState, lotteryReducer } from '../machine/lotteryMachine';
import type { LotteryState, Phase } from '../machine/lotteryMachine';
import { Cooldown, DwellLatch, LowPass, clamp, isUpright, screenTilt } from '../lib/sensorMath';
import { probeSensorData, requestSensorPermission } from '../lib/permissions';
import type { LotteryAudio } from './useLotteryAudio';
import type { Fortune } from '../types/fortune';

/* ------------------------------------------------------------------ */
/* 可調參數：實機測試後只需要改這裡                                     */
/* ------------------------------------------------------------------ */
export interface SensorTuning {
  /** 低通濾波時間常數（ms）：越大越不怕手抖 */
  tiltTauMs: number;
  /** 叩首：pitch ≤ bowEnter 算「拜下去」，≥ bowExit 算「回正」，中間是遲滯緩衝帶 */
  bowEnter: number;
  bowExit: number;
  /** 叩首／回正都要維持這麼久才算數（防手抖誤判） */
  bowDwellMs: number;
  /** 兩次叩首最短間隔 */
  bowCooldownMs: number;
  /** 線性加速度（m/s²，已扣重力）超過才算在搖 */
  shakeMin: number;
  /** 視為「用力搖」的上限，用來把力道換算成 0~1 */
  shakeMax: number;
  /** 單次竹籤碰撞的門檻 */
  hitThreshold: number;
  /** 碰撞音最短間隔：慢搖 → 快搖（越快越頻繁） */
  hitGapSlowMs: number;
  hitGapFastMs: number;
  /** 進度增益：每秒進度 ≈ (力道 - shakeMin) × gain */
  shakeGain: number;
  /** 出籤：pitch < pourBelow 並維持 pourDwellMs */
  pourBelow: number;
  pourDwellMs: number;
  /** 直立判斷改變後要維持多久才更新 UI 提示 */
  uprightDwellMs: number;
  /** 震動最短間隔（Android 連續 vibrate 會互相打斷） */
  vibrateGapMs: number;
}

export const DEFAULT_TUNING: SensorTuning = {
  tiltTauMs: 120,
  bowEnter: 55,
  bowExit: 75,
  bowDwellMs: 180,
  bowCooldownMs: 600,
  shakeMin: 4,
  shakeMax: 25,
  hitThreshold: 9,
  hitGapSlowMs: 160,
  hitGapFastMs: 55,
  shakeGain: 3,
  pourBelow: 45,
  pourDwellMs: 300,
  uprightDwellMs: 300,
  vibrateGapMs: 90,
};

/* ------------------------------------------------------------------ */
/* 給 3D 場景每一幀讀取的即時數值（放 ref，不觸發 React 重繪）           */
/* ------------------------------------------------------------------ */
export interface LiveSensors {
  hasData: boolean;
  /** 濾波後前後傾角（直立 ≈ 90°） */
  pitch: number;
  /** 濾波後左右歪斜 */
  roll: number;
  /** 搖晃能量 0~1（平滑過） */
  shakeEnergy: number;
  /** 最近一次竹籤碰撞的時間（performance.now）與力道 0~1 */
  lastHitAt: number;
  lastHitIntensity: number;
  /** 叩首傾斜程度 0~1（給 3D 人偶／籤筒跟著鞠躬） */
  bowLean: number;
  /** 出籤傾倒程度 0~1（給籤筒跟著往前倒） */
  pourLean: number;
}

const createLive = (): LiveSensors => ({
  hasData: false,
  pitch: 90,
  roll: 0,
  shakeEnergy: 0,
  lastHitAt: -Infinity,
  lastHitIntensity: 0,
  bowLean: 0,
  pourLean: 0,
});

/** 用 crypto 亂數抽籤（比 Math.random 均勻、不可預測） */
export function pickFortune(list: readonly Fortune[]): Fortune {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return list[u[0] % list.length];
}

const SENSOR_PHASES: readonly Phase[] = ['bow', 'ready', 'shake', 'pour'];

export interface UseLotterySensorsOptions {
  audio: LotteryAudio;
  fortunes: readonly Fortune[];
  tuning?: Partial<SensorTuning>;
}

export interface UseLotterySensorsResult {
  state: LotteryState;
  live: MutableRefObject<LiveSensors>;
  fortune: Fortune | null;
  actions: {
    purifyProgress: (ratio: number) => void;
    purifyDone: () => void;
    /** ⚠️ 必須直接綁在 onClick 上（iOS 權限要在使用者手勢內請求） */
    beginBow: () => void;
    /** ⚠️ 也綁在 onClick 上（順便解鎖音效、震動的使用者啟用條件） */
    startShake: () => void;
    /** 3D 竹籤落地後呼叫 → 展開卷軸 */
    stickLanded: () => void;
    reset: () => void;
  };
  /** 沒有感測器時的替代操作（桌機測試、權限被拒） */
  simulate: { bow: () => void; shake: () => void; pour: () => void };
}

export function useLotterySensors({ audio, fortunes, tuning }: UseLotterySensorsOptions): UseLotterySensorsResult {
  const T = useMemo(() => ({ ...DEFAULT_TUNING, ...tuning }), [tuning]);
  const [state, dispatch] = useReducer(lotteryReducer, initialLotteryState);
  const live = useRef<LiveSensors>(createLive());

  // 事件處理函式只掛一次，用 ref 讀最新值，避免每次重繪都重掛監聽
  const phaseRef = useRef<Phase>(state.phase);
  phaseRef.current = state.phase;
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const fortunesRef = useRef(fortunes);
  fortunesRef.current = fortunes;

  const lastVibrate = useRef(0);
  const vibrate = useCallback(
    (pattern: number | number[], now = performance.now()) => {
      if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return; // iOS Safari 不支援
      if (now - lastVibrate.current < T.vibrateGapMs) return;
      lastVibrate.current = now;
      navigator.vibrate(pattern);
    },
    [T.vibrateGapMs],
  );

  const draw = useCallback(() => {
    const f = pickFortune(fortunesRef.current);
    dispatch({ type: 'POUR', fortuneId: f.id });
    audioRef.current.playDrawn();
    vibrate([60, 40, 120]);
  }, [vibrate]);

  /* -------------------------- 感測器監聽 -------------------------- */
  const sensorsActive = !state.fallbackMode && state.permission === 'granted' && SENSOR_PHASES.includes(state.phase);

  // 每次換階段都重置手勢判斷，避免上一階段的姿勢殘留誤觸
  const gesture = useRef({
    bowLatch: new DwellLatch((v) => v <= T.bowEnter, (v) => v >= T.bowExit, T.bowDwellMs),
    bowCooldown: new Cooldown(T.bowCooldownMs),
    bowArmed: false,
    pourLatch: new DwellLatch((v) => v < T.pourBelow, () => false, T.pourDwellMs),
  });
  useEffect(() => {
    const g = gesture.current;
    g.bowLatch = new DwellLatch((v) => v <= T.bowEnter, (v) => v >= T.bowExit, T.bowDwellMs);
    g.bowCooldown = new Cooldown(T.bowCooldownMs);
    g.bowArmed = false;
    g.pourLatch = new DwellLatch((v) => v < T.pourBelow, () => false, T.pourDwellMs);
    live.current.bowLean = 0;
    live.current.pourLean = 0;
  }, [state.phase, T]);

  useEffect(() => {
    if (!sensorsActive) return;
    const L = live.current;
    const pitchLP = new LowPass(T.tiltTauMs);
    const rollLP = new LowPass(T.tiltTauMs);
    const gravLP = [new LowPass(250), new LowPass(250), new LowPass(250)];
    const energyLP = new LowPass(200);
    let lastOri = performance.now();
    let lastMot = performance.now();
    let pendingProgress = 0;
    let aboveHit = false;
    let upright = true;
    let uprightCandidateSince: number | null = null;

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const now = performance.now();
      const dt = clamp(now - lastOri, 1, 200);
      lastOri = now;
      const raw = screenTilt(e.beta, e.gamma);
      const pitch = pitchLP.push(raw.pitch, dt);
      const roll = rollLP.push(raw.roll, dt);
      L.hasData = true;
      L.pitch = pitch;
      L.roll = roll;

      // 直立提示（加持續時間，避免提示文字閃爍）
      const up = isUpright(pitch, roll);
      if (up === upright) uprightCandidateSince = null;
      else {
        uprightCandidateSince ??= now;
        if (now - uprightCandidateSince >= T.uprightDwellMs) {
          upright = up;
          uprightCandidateSince = null;
          dispatch({ type: 'UPRIGHT', ok: up });
        }
      }

      const g = gesture.current;
      const phase = phaseRef.current;

      if (phase === 'bow') {
        L.bowLean = clamp((T.bowExit + 15 - pitch) / (T.bowExit + 15 - T.bowEnter), 0, 1);
        // 先確認使用者「已經把手機直立貼在胸前」才開始數，避免一開始就斜拿被算一次
        if (!g.bowArmed) {
          if (pitch >= T.bowExit) g.bowArmed = true;
          return;
        }
        const ev = g.bowLatch.update(pitch, now);
        if (ev === 'enter') vibrate(25, now); // 拜下去：輕輕一震
        if (ev === 'exit' && g.bowCooldown.tryPass(now)) {
          dispatch({ type: 'BOW' }); // 回正才算完成一叩
          audioRef.current.playClack(0.3);
          vibrate(60, now);
        }
      } else if (phase === 'pour') {
        L.pourLean = clamp((90 - pitch) / (90 - T.pourBelow), 0, 1);
        if (g.pourLatch.update(pitch, now) === 'enter') draw();
      }
    };

    const onMotion = (e: DeviceMotionEvent) => {
      const now = performance.now();
      const dt = clamp(now - lastMot, 1, 100);
      lastMot = now;

      // 1) 取得「扣掉重力」的線性加速度大小
      let mag: number;
      const a = e.acceleration;
      if (a && a.x !== null && a.y !== null && a.z !== null) {
        mag = Math.hypot(a.x, a.y, a.z);
      } else {
        // 部分 Android 只給含重力的值 → 低通取出重力，再相減（高通濾波）
        const g = e.accelerationIncludingGravity;
        if (!g || g.x === null || g.y === null || g.z === null) return;
        const gx = gravLP[0].push(g.x, dt), gy = gravLP[1].push(g.y, dt), gz = gravLP[2].push(g.z, dt);
        mag = Math.hypot(g.x - gx, g.y - gy, g.z - gz);
      }

      const norm = clamp((mag - T.shakeMin) / (T.shakeMax - T.shakeMin), 0, 1);
      L.shakeEnergy = energyLP.push(norm, dt);
      if (phaseRef.current !== 'shake') return;

      // 2) 累積進度：只在直立時累積（籤筒倒著搖，籤會掉出來）
      if (upright && mag > T.shakeMin) pendingProgress += (mag - T.shakeMin) * T.shakeGain * (dt / 1000);

      // 3) 竹籤碰撞：越過門檻的「上升邊緣」才算一次；搖越快，允許的間隔越短
      const gap = T.hitGapSlowMs + (T.hitGapFastMs - T.hitGapSlowMs) * L.shakeEnergy;
      if (mag > T.hitThreshold && !aboveHit && now - L.lastHitAt >= gap) {
        aboveHit = true;
        const intensity = clamp((mag - T.hitThreshold) / (T.shakeMax - T.hitThreshold), 0.1, 1);
        L.lastHitAt = now;
        L.lastHitIntensity = intensity;
        audioRef.current.playClack(intensity);
        vibrate(Math.round(8 + 30 * intensity), now);
      } else if (mag < T.hitThreshold * 0.7) {
        aboveHit = false; // 遲滯：降到 70% 以下才允許下一次碰撞
      }
    };

    // 4) 進度批次送進 reducer（每 100ms 一次），不讓 60Hz 感測器把 React 重繪塞爆
    const flush = window.setInterval(() => {
      if (pendingProgress > 0) {
        dispatch({ type: 'SHAKE_ADD', amount: pendingProgress });
        pendingProgress = 0;
      }
    }, 100);

    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('devicemotion', onMotion);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('devicemotion', onMotion);
      window.clearInterval(flush);
    };
  }, [sensorsActive, T, draw, vibrate]);

  // 搖完 → 進入出籤階段時給一個提示震動
  useEffect(() => {
    if (state.phase === 'pour') vibrate([80, 60, 80]);
  }, [state.phase, vibrate]);

  // 保險：3D 動畫萬一沒回報落地，3 秒後也展開卷軸
  useEffect(() => {
    if (state.phase !== 'drawn') return;
    const t = window.setTimeout(() => dispatch({ type: 'OPEN_SCROLL' }), 3000);
    return () => window.clearTimeout(t);
  }, [state.phase]);

  /* ---------------------------- actions ---------------------------- */
  const beginBow = useCallback(() => {
    audioRef.current.unlock();
    // requestSensorPermission 內部會「同步」呼叫 iOS 的 requestPermission，所以這行前面不能有 await
    void requestSensorPermission().then(async (result) => {
      if (result !== 'granted') return dispatch({ type: 'PERMISSION_RESULT', result });
      const ok = await probeSensorData();
      dispatch({ type: 'PERMISSION_RESULT', result: ok ? 'granted' : 'unsupported' });
    });
  }, []);

  const actions = useMemo(
    () => ({
      purifyProgress: (ratio: number) => dispatch({ type: 'PURIFY_PROGRESS', value: ratio }),
      purifyDone: () => {
        dispatch({ type: 'PURIFY_DONE' });
        vibrate(50);
      },
      beginBow,
      startShake: () => {
        audioRef.current.unlock();
        dispatch({ type: 'START_SHAKE' });
      },
      stickLanded: () => dispatch({ type: 'OPEN_SCROLL' }),
      reset: () => {
        live.current = createLive();
        dispatch({ type: 'RESET' });
      },
    }),
    [beginBow, vibrate],
  );

  const simulate = useMemo(
    () => ({
      bow: () => {
        if (phaseRef.current !== 'bow') return;
        dispatch({ type: 'BOW' });
        audioRef.current.playClack(0.3);
      },
      shake: () => {
        if (phaseRef.current !== 'shake') return;
        const k = 0.4 + Math.random() * 0.5;
        live.current.lastHitAt = performance.now();
        live.current.lastHitIntensity = k;
        live.current.shakeEnergy = k;
        audioRef.current.playClack(k);
        dispatch({ type: 'SHAKE_ADD', amount: 12 });
      },
      pour: () => {
        if (phaseRef.current === 'pour') draw();
      },
    }),
    [draw],
  );

  const fortune = useMemo(
    () => (state.fortuneId === null ? null : fortunes.find((f) => f.id === state.fortuneId) ?? null),
    [state.fortuneId, fortunes],
  );

  return { state, live, fortune, actions, simulate };
}
