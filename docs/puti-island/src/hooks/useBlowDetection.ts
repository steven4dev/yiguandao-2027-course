/**
 * useBlowDetection：用麥克風偵測「吹氣」，累積 progress 0～100
 *
 * 原理（跟原生版 islands/index.html 的 ptAnalyse / ptTick 同一套）：
 *   每一幀用 AnalyserNode 取三個特徵——
 *     1. rmsDb      整體音量（dBFS，0 最大聲）
 *     2. flatness   150–4000 Hz 的頻譜平坦度＝幾何平均÷算術平均。吹氣是沙沙的寬頻雜訊（高）；
 *                   說話、唱歌是一根根諧波（低，通常 < 0.05）
 *     3. lowShare   600 Hz 以下能量占 60–6000 Hz 的比例。嘴巴對著麥克風吹，風切聲大多在低頻；
 *                   「嘶～」「噓～」這類高頻氣音占比低，不算
 *   「是吹氣」＝ 夠大聲（比底噪大 margin dB、且 ≥ absMin）且 像風聲（flatness、lowShare 都過門檻；
 *   或非常大聲時放寬 flatness），並且連續 holdMs 才算開始、中斷 releaseMs 才算停（濾掉拍手、敲桌）。
 *
 * 注意事項：
 *   - getUserMedia 一定要關掉 noiseSuppression / echoCancellation / autoGainControl：
 *     瀏覽器的降噪會把吹氣的風聲當雜訊濾掉。
 *   - analyser 只接 source，不接 destination：不會回授，也沒有錄音。
 *   - iOS Safari 17+：開麥克風前把 navigator.audioSession.type 設成 'play-and-record'，關掉後改回。
 *   - 開麥克風期間，網頁自己的背景音樂要先淡出（喇叭聲會被收進去，干擾判斷）——由呼叫端處理，
 *     這個 hook 回傳的 status !== 'idle' 時就是麥克風開著。
 *   - 計時一律用 performance.now() 的真實時間，不用被截短的 frame dt：手機卡頓時秒數才不會變慢。
 *   - progress 只以約 15Hz 更新 React state；每一幀要讀的數值（給 R3F useFrame）放在 ref 裡，避免整棵樹重畫。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface BlowDetectionOptions {
  /** 開麥克風後先安靜聽多久，當作環境底噪（毫秒） */
  calibMs?: number;
  /** 要比底噪大多少 dB 才可能是吹氣 */
  margin?: number;
  /** 絕對下限（dBFS）：很安靜的房間底噪很低，避免小聲說話就過門檻 */
  absMin?: number;
  /** 頻譜平坦度門檻（0～1） */
  flat?: number;
  /** 600 Hz 以下能量占比門檻 */
  lowShare?: number;
  /** 非常大聲（dBFS）時，平坦度門檻放寬成 flatLoud */
  loud?: number;
  flatLoud?: number;
  /** 連續多久才算開始吹、中斷多久才算停（毫秒） */
  holdMs?: number;
  releaseMs?: number;
  /** 從 0 吹到 100 需要累積的時間（毫秒）；用力吹會快一點 */
  needMs?: number;
  /** 停下來超過多久開始退、每秒退幾 % */
  decayAfterMs?: number;
  decayPerSec?: number;
  /** progress 到 100 時呼叫（hook 會先自動關掉麥克風，鎖定狀態） */
  onCleared?: () => void;
  /** 傳入現成的 AudioContext（建議跟網頁音效共用同一個，iOS 上比較穩）；不傳就自己開一個、結束時關掉 */
  audioContext?: AudioContext | null;
}

export type MicStatus =
  | 'idle'          // 沒開麥克風
  | 'requesting'    // 等使用者按「允許」
  | 'calibrating'   // 量底噪中（請先別吹）
  | 'listening'     // 偵測中
  | 'cleared';      // 吹滿、已鎖定

export type MicError = 'denied' | 'unsupported' | 'insecure' | 'nomic' | 'inapp' | 'ended' | 'error';

/** 沒在吹的原因（給 UI 提示用） */
export type QuietReason = '' | 'quiet' | 'voice';

export interface BlowFrame { rmsDb: number; flatness: number; lowShare: number }

export interface BlowDetection {
  status: MicStatus;
  error: MicError | null;
  /** 0～100（約 15Hz 更新） */
  progress: number;
  isBlowing: boolean;
  /** 音量條：0～1，以及門檻線的位置 0～1 */
  level: number;
  gate: number;
  reason: QuietReason;
  /** 每一幀讀的數值（給 useFrame 用，不會觸發重畫）：progress 0～1、gust 吹氣力道 0～1 */
  progressRef: React.MutableRefObject<number>;
  gustRef: React.MutableRefObject<number>;
  /** 一定要在使用者點擊的 handler 裡呼叫（iOS 要靠手勢才能啟動 AudioContext） */
  start: () => Promise<void>;
  /** 關麥克風、放掉所有音訊節點；progress 保留 */
  stop: () => void;
  /** 歸零重來 */
  reset: () => void;
  /** 沒有麥克風時的替代：按住吹氣（true 開始、false 停） */
  setManualBlow: (on: boolean) => void;
}

const DEFAULTS = {
  calibMs: 800, margin: 14, absMin: -52, flat: 0.2, lowShare: 0.35, loud: -24, flatLoud: 0.1,
  holdMs: 140, releaseMs: 220, needMs: 3200, decayAfterMs: 800, decayPerSec: 8,
};

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const isInAppBrowser = () => typeof navigator !== 'undefined' && /\bLine\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent);
type AudioSessionNav = Navigator & { audioSession?: { type: string } };
const setSession = (type: string) => { try { const s = (navigator as AudioSessionNav).audioSession; if (s) s.type = type; } catch { /* 舊版瀏覽器沒有 */ } };

/** 從 AnalyserNode 取一幀特徵（純函式，方便單元測試） */
export function analyseFrame(an: AnalyserNode, sampleRate: number, time: Float32Array, freq: Float32Array): BlowFrame {
  let sum = 0;
  an.getFloatTimeDomainData(time);
  for (let i = 0; i < time.length; i++) sum += time[i] * time[i];
  const rmsDb = 10 * Math.log10(sum / time.length + 1e-12);
  an.getFloatFrequencyData(freq);
  const hz = sampleRate / an.fftSize;
  const bin = (f: number) => clamp(Math.round(f / hz), 1, freq.length - 1);
  const b60 = bin(60), b150 = bin(150), b600 = bin(600), b4k = bin(4000), b6k = bin(6000);
  let low = 0, all = 0, dbSum = 0, lin = 0, n = 0;
  for (let i = b60; i <= b6k; i++) {
    const db = Number.isFinite(freq[i]) ? Math.max(-140, freq[i]) : -140;
    const p = Math.pow(10, db / 10);
    all += p;
    if (i <= b600) low += p;
    if (i >= b150 && i <= b4k) { dbSum += db; lin += p; n++; }
  }
  const flatness = n && lin > 0 ? Math.pow(10, dbSum / n / 10) / (lin / n) : 0;
  return { rmsDb, flatness, lowShare: all > 0 ? low / all : 0 };
}

export function useBlowDetection(options: BlowDetectionOptions = {}): BlowDetection {
  const opt = { ...DEFAULTS, ...options };
  const optRef = useRef(opt); optRef.current = opt;

  const [status, setStatus] = useState<MicStatus>('idle');
  const [error, setError] = useState<MicError | null>(null);
  const [ui, setUi] = useState({ progress: 0, isBlowing: false, level: 0, gate: 0.4, reason: '' as QuietReason });

  const progressRef = useRef(0);    // 0～1
  const gustRef = useRef(0);        // 0～1
  const statusRef = useRef<MicStatus>('idle');
  const manualRef = useRef(false);
  const audio = useRef<{
    stream: MediaStream | null; src: MediaStreamAudioSourceNode | null; an: AnalyserNode | null;
    ctx: AudioContext | null; own: boolean; time: Float32Array; freq: Float32Array;
  }>({ stream: null, src: null, an: null, ctx: null, own: false, time: new Float32Array(0), freq: new Float32Array(0) });
  const det = useRef({ floor: -70, calib: [] as number[], calibUntil: 0, cand: 0, rel: 0, blowing: false, lastBlow: 0, last: 0, uiAt: 0 });
  const raf = useRef(0);

  const setStat = (s: MicStatus) => { statusRef.current = s; setStatus(s); };

  /** 關麥克風、放掉節點（cleanup 的核心） */
  const releaseMic = useCallback(() => {
    const a = audio.current;
    try { a.src?.disconnect(); } catch { /* 已斷開 */ }
    try { a.an?.disconnect(); } catch { /* 已斷開 */ }
    if (a.stream) { a.stream.getTracks().forEach((t) => t.stop()); setSession('playback'); }
    if (a.own && a.ctx) a.ctx.close().catch(() => undefined);
    Object.assign(a, { stream: null, src: null, an: null, ctx: null, own: false });
  }, []);

  const stopLoop = () => { cancelAnimationFrame(raf.current); raf.current = 0; };

  const stop = useCallback(() => {
    stopLoop(); releaseMic();
    manualRef.current = false; gustRef.current = 0;
    if (statusRef.current !== 'cleared') setStat('idle');
  }, [releaseMic]);

  /** 每一幀：讀特徵 → 判斷吹氣 → 累積 progress */
  const loop = useCallback(() => {
    const o = optRef.current, d = det.current, a = audio.current;
    const now = performance.now(), dt = Math.min(0.25, (now - (d.last || now)) / 1000); d.last = now;
    let strength = 0, level = 0, gate = 0.4, reason: QuietReason = '';

    if (a.an && a.ctx) {
      const f = analyseFrame(a.an, a.ctx.sampleRate, a.time, a.freq);
      if (statusRef.current === 'calibrating') {
        if (f.rmsDb > -100) d.calib.push(f.rmsDb);   // 剛打開時的全零（數位靜音）不算
        if (now >= d.calibUntil) {
          const s = d.calib.slice().sort((x, y) => x - y);
          // 取第 25 百分位：就算校正時已經開始吹，底噪也不會被墊得太高
          d.floor = s.length ? clamp(s[Math.floor(s.length / 4)], -90, -45) : -70;
          setStat('listening');
        }
      } else {
        const g = Math.max(d.floor + o.margin, o.absMin);
        const loud = f.rmsDb >= g;
        const windy = (f.flatness >= o.flat && f.lowShare >= o.lowShare) || (f.rmsDb >= o.loud && f.flatness >= o.flatLoud);
        if (loud && windy) { d.cand += dt * 1000; d.rel = 0; } else { d.cand = 0; if (d.blowing) d.rel += dt * 1000; }
        if (!d.blowing && d.cand >= o.holdMs) d.blowing = true;
        if (d.blowing && d.rel >= o.releaseMs) d.blowing = false;
        strength = clamp((f.rmsDb - g) / 18, 0, 1);
        const span = o.margin + 22;
        level = clamp((f.rmsDb - d.floor) / span, 0, 1);
        gate = clamp((g - d.floor) / span, 0, 1);
        reason = d.blowing ? '' : loud && !windy ? 'voice' : 'quiet';
        if (!loud) d.floor += (Math.min(f.rmsDb, d.floor + 6) - d.floor) * 0.01;   // 環境慢慢變化時跟上
      }
    } else if (statusRef.current === 'listening') {
      // 按住吹氣模式
      d.blowing = manualRef.current; strength = d.blowing ? 0.6 : 0; level = d.blowing ? 0.75 : 0;
    }

    if (statusRef.current === 'listening') {
      let p = progressRef.current * 100;
      if (d.blowing) { d.lastBlow = now; p = Math.min(100, p + ((dt * 1000) / o.needMs) * 100 * (0.6 + 0.8 * strength)); }
      else if (now - d.lastBlow > o.decayAfterMs) p = Math.max(0, p - o.decayPerSec * dt);
      progressRef.current = p / 100;
      const target = d.blowing ? 0.45 + 0.55 * strength : 0;
      gustRef.current += (target - gustRef.current) * (1 - Math.exp(-(d.blowing ? 8 : 3) * dt));
      if (p >= 100) {
        // 鎖定：關麥克風、通知外面
        stopLoop(); releaseMic(); d.blowing = false; gustRef.current = 0;
        setStat('cleared');
        setUi({ progress: 100, isBlowing: false, level: 0, gate, reason: '' });
        optRef.current.onCleared?.();
        return;
      }
    }
    if (now - d.uiAt > 70) { d.uiAt = now; setUi({ progress: progressRef.current * 100, isBlowing: d.blowing, level, gate, reason }); }
    raf.current = requestAnimationFrame(loop);
  }, [releaseMic]);

  const start = useCallback(async () => {
    if (statusRef.current === 'requesting' || statusRef.current === 'calibrating' || statusRef.current === 'listening') return;
    setError(null);
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!window.isSecureContext) { setError('insecure'); return; }
    if (!navigator.mediaDevices?.getUserMedia || !AC) { setError(isInAppBrowser() ? 'inapp' : 'unsupported'); return; }
    // 先在手勢裡把 AudioContext 叫醒（iOS 必須），再要麥克風
    let ctx = optRef.current.audioContext ?? null, own = false;
    if (!ctx) { ctx = new AC(); own = true; }
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined);
    setStat('requesting');
    setSession('play-and-record');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      setSession('playback');
      if (own) ctx.close().catch(() => undefined);
      const n = (e as DOMException)?.name;
      setError(n === 'NotAllowedError' || n === 'SecurityError' ? (isInAppBrowser() ? 'inapp' : 'denied') : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nomic' : 'error');
      setStat('idle');
      return;
    }
    // await 期間使用者可能已經取消（stop／reset 會改掉狀態），要重新讀一次
    if ((statusRef.current as MicStatus) !== 'requesting') { stream.getTracks().forEach((t) => t.stop()); setSession('playback'); if (own) ctx.close().catch(() => undefined); return; }
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    an.fftSize = 1024; an.smoothingTimeConstant = 0.25;
    src.connect(an);   // 只接分析器，不接喇叭
    Object.assign(audio.current, { stream, src, an, ctx, own, time: new Float32Array(an.fftSize), freq: new Float32Array(an.frequencyBinCount) });
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { stop(); setError('ended'); });   // 來電、藍牙耳機斷線
    Object.assign(det.current, { calib: [], calibUntil: performance.now() + optRef.current.calibMs, cand: 0, rel: 0, blowing: false, last: 0 });
    setStat('calibrating');
    stopLoop(); raf.current = requestAnimationFrame(loop);
  }, [loop, stop]);

  const setManualBlow = useCallback((on: boolean) => {
    manualRef.current = on;
    if (on && statusRef.current === 'idle') {   // 第一次按住就進入偵測（不開麥克風）
      Object.assign(det.current, { last: 0, blowing: false });
      setStat('listening');
      stopLoop(); raf.current = requestAnimationFrame(loop);
    }
  }, [loop]);

  const reset = useCallback(() => {
    stop();
    progressRef.current = 0; gustRef.current = 0;
    setStat('idle'); setError(null);
    setUi({ progress: 0, isBlowing: false, level: 0, gate: 0.4, reason: '' });
  }, [stop]);

  // 切到背景、離開頁面：馬上關麥克風（手機狀態列的麥克風圖示才會消失）
  useEffect(() => {
    const onHide = () => { if (document.hidden && statusRef.current !== 'cleared') stop(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', stop);
      stopLoop(); releaseMic();   // 元件卸載：一定要放掉麥克風
    };
  }, [stop, releaseMic]);

  return { status, error, ...ui, progressRef, gustRef, start, stop, reset, setManualBlow };
}
