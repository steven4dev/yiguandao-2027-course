import { useCallback, useEffect, useRef } from 'react';

/**
 * Web Audio 即時合成音效（沿用全真群島的做法：不用音檔、沒有版權問題）
 *  - 水流：粉紅雜訊 → 帶通濾波，LFO 讓水聲有起伏
 *  - 竹籤碰撞：極短的雜訊爆音＋高頻共振（竹子的「喀」聲），力道越大越響、越亮
 *  - 出籤：一聲木魚＋鈴聲
 *
 * iOS 規定 AudioContext 要在使用者手勢中 resume()，所以 unlock() 要掛在第一次觸碰／點擊上。
 */
export function useLotteryAudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const noiseRef = useRef<AudioBuffer | null>(null);
  const waterRef = useRef<{ src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null>(null);

  const unlock = useCallback(() => {
    if (!ctxRef.current) {
      const AC =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      // 2 秒粉紅雜訊（Paul Kellet 近似法）
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
      ctxRef.current = ctx;
      masterRef.current = master;
      noiseRef.current = buf;
    }
    if (ctxRef.current.state !== 'running') void ctxRef.current.resume();
  }, []);

  const startWater = useCallback(() => {
    const ctx = ctxRef.current, buf = noiseRef.current, master = masterRef.current;
    if (!ctx || !buf || !master || waterRef.current) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.7;
    lfoGain.gain.value = 400; // 濾波頻率在 500~1300Hz 間擺動 → 潺潺水聲
    lfo.connect(lfoGain).connect(bp.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.15);
    src.connect(bp).connect(gain).connect(master);
    src.start();
    lfo.start();
    waterRef.current = { src, gain, lfo };
  }, []);

  const stopWater = useCallback(() => {
    const ctx = ctxRef.current, w = waterRef.current;
    if (!ctx || !w) return;
    w.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    w.src.stop(ctx.currentTime + 1.2);
    w.lfo.stop(ctx.currentTime + 1.2);
    waterRef.current = null;
  }, []);

  /** 竹籤碰撞聲；intensity 0~1，越大越響、音色越亮 */
  const playClack = useCallback((intensity: number) => {
    const ctx = ctxRef.current, buf = noiseRef.current, master = masterRef.current;
    if (!ctx || !buf || !master) return;
    const t = ctx.currentTime;
    const k = Math.min(1, Math.max(0.15, intensity));
    // 一次碰撞發出 1~3 聲（好幾根籤一起撞）
    const hits = 1 + Math.floor(Math.random() * (1 + k * 2));
    for (let i = 0; i < hits; i++) {
      const at = t + i * (0.012 + Math.random() * 0.025);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1.5;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + Math.random() * 1400 + k * 1200;
      bp.Q.value = 6 + Math.random() * 6; // 高 Q → 有「竹管」的共鳴感
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.25 + k * 0.75, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05 + Math.random() * 0.03);
      src.connect(bp).connect(g).connect(master);
      src.start(at, Math.random() * 1.5, 0.1);
    }
  }, []);

  /** 出籤：木魚「叩」＋高音鈴 */
  const playDrawn = useCallback(() => {
    const ctx = ctxRef.current, master = masterRef.current;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const tone = (freq: number, at: number, dur: number, vol: number, type: OscillatorType) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(master);
      o.start(at);
      o.stop(at + dur + 0.05);
    };
    tone(320, t, 0.18, 0.6, 'sine'); // 木魚
    tone(1568, t + 0.25, 2.2, 0.25, 'sine'); // 鈴 G6
    tone(2349, t + 0.25, 1.6, 0.1, 'sine'); // 泛音
  }, []);

  useEffect(
    () => () => {
      void ctxRef.current?.close();
      ctxRef.current = null;
    },
    [],
  );

  return { unlock, startWater, stopWater, playClack, playDrawn };
}

export type LotteryAudio = ReturnType<typeof useLotteryAudio>;
