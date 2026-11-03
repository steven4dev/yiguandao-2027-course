/**
 * 組起來：狀態機 × 吹氣偵測 × Canvas 層 × UI 層
 * （群島目前是原生 Three.js，這支是日後搬到 React 時的對照組；邏輯與 islands/index.html 的 pt* 函式一一對應）
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBlowDetection } from './hooks/useBlowDetection';
import { initialPutiState, pickQuote, putiReducer } from './machine/putiMachine';
import { PutiCanvas, type PutiSceneRefs } from './scene/PutiCanvas';
import { BlowMeter, MicPrompt, QuotePanel } from './ui/PutiPanel';
import { BODHI_QUOTES, IS_DEMO_QUOTES } from './data/quotes.mock';
import type { BodhiRecord } from './types/quote';

const KEY = 'islands-puti';
const SHARE_URL = 'https://steven4dev.github.io/yiguandao-2027-course/islands/puti/';
const todayTW = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const load = (): BodhiRecord => { try { const o = JSON.parse(localStorage.getItem(KEY) || 'null'); if (o?.v === 1) return o; } catch { /* 無痕模式 */ } return { v: 1, day: '', today: 0, got: {} }; };
const save = (r: BodhiRecord) => { try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* 存不了也能玩 */ } };

/** 引磬「叮～」：用 Web Audio 合成，不用音檔；一定要在麥克風關掉之後才敲（iOS 要先切回播放模式） */
function ding(ctx: AudioContext) {
  const t = ctx.currentTime + 0.05, out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
  for (const [m, v] of [[1, 1], [2.76, 0.3], [5.4, 0.1], [0.5, 0.12]]) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 1568 * m;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5 / Math.sqrt(m));
    o.connect(g).connect(out); o.start(t); o.stop(t + 6);
  }
}

export function PutiIsland({ audioContext, onDuckMusic }: { audioContext?: AudioContext | null; onDuckMusic?: (duck: boolean) => void }) {
  const [state, dispatch] = useReducer(putiReducer, initialPutiState);
  const [rec, setRec] = useState<BodhiRecord>(load);
  const todayQuote = rec.day === todayTW() ? BODHI_QUOTES.find((q) => q.id === rec.today) ?? null : null;
  const refs: PutiSceneRefs = { fog: useRef(todayQuote ? 1 : 0), gust: useRef(0), bloom: useRef(todayQuote ? 1 : 0) };

  const onCleared = useCallback(() => {
    const q = pickQuote(BODHI_QUOTES, rec.got), day = todayTW();
    const next: BodhiRecord = { ...rec, day, today: q.id, got: rec.got[q.id] ? rec.got : { ...rec.got, [q.id]: day } };
    save(next); setRec(next);
    dispatch({ type: 'CLEARED', quote: q });
    navigator.vibrate?.([60, 50, 140]);
    setTimeout(() => audioContext && ding(audioContext), 350);
    setTimeout(() => dispatch({ type: 'OPEN_CARD', quote: q }), 2600);   // 先看蓮花開、金字浮現，再展開金句
  }, [rec, audioContext]);

  const blow = useBlowDetection({ onCleared, audioContext });

  // 麥克風開著（或正在要權限）時，請群島把背景音樂淡出
  useEffect(() => { onDuckMusic?.(state.phase === 'askMic' || (state.phase === 'blowing' && state.mode === 'mic')); }, [state.phase, state.mode, onDuckMusic]);
  // 麥克風準備好 → 進入吹氣；拿不到麥克風 → 改按住吹氣
  useEffect(() => { if (state.phase === 'askMic' && (blow.status === 'calibrating' || blow.status === 'listening')) dispatch({ type: 'MIC_READY' }); }, [state.phase, blow.status]);
  useEffect(() => { if (blow.error && (state.phase === 'askMic' || state.phase === 'blowing')) { blow.stop(); dispatch({ type: 'USE_TOUCH', reason: blow.error }); } }, [blow.error, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => { blow.reset(); dispatch({ type: 'START' }); };
  const abort = () => { blow.stop(); dispatch({ type: 'ABORT' }); };
  const useTouch = () => { blow.stop(); dispatch({ type: 'USE_TOUCH', reason: 'manual' }); };

  return (
    <>
      <PutiCanvas refs={refs}>
        <SceneDriver refs={refs} progressRef={blow.progressRef} gustRef={blow.gustRef} cleared={state.phase === 'cleared' || !!todayQuote} blowing={state.phase === 'blowing'} />
      </PutiCanvas>
      <aside className="panel">
        {state.phase === 'idle' && (todayQuote
          ? <div className="cta"><p>今天已經雲開見日 🪷<br /><b>{todayQuote.title}</b>：「{todayQuote.quote}」</p><button type="button" onClick={() => dispatch({ type: 'OPEN_CARD', quote: todayQuote })}>🪷 再看一次金句</button></div>
          : <div className="cta"><p>清淨菩提島被一層無明的雲霧蓋住了。對著麥克風長吹一口氣「呼——」，把雲霧吹散。</p><button type="button" onClick={start}>🌬️ 開始吹散無明</button></div>)}
        {state.phase === 'askMic' && <MicPrompt onMic={blow.start} onTouch={useTouch} onCancel={abort} waiting={blow.status === 'requesting'} />}
        {state.phase === 'blowing' && <BlowMeter blow={blow} state={state} onTouch={useTouch} onCancel={abort} />}
        {state.phase === 'cleared' && <p className="say">雲開了⋯⋯蓮花綻放，石碑浮現金字 ✨</p>}
      </aside>
      <QuotePanel quote={state.quote} open={state.cardOpen} again={state.phase !== 'cleared'} demo={IS_DEMO_QUOTES} shareUrl={SHARE_URL} onClose={() => dispatch({ type: 'CARD_CLOSED' })} />
    </>
  );
}

/** 把吹氣進度轉成 3D 用的數值（要放在 <Canvas> 裡面才能用 useFrame） */
function SceneDriver({ refs, progressRef, gustRef, cleared, blowing }: { refs: PutiSceneRefs; progressRef: React.MutableRefObject<number>; gustRef: React.MutableRefObject<number>; cleared: boolean; blowing: boolean }) {
  useFrame((_, dt) => {
    const target = blowing ? progressRef.current : cleared ? 1 : 0;
    refs.fog.current += (target - refs.fog.current) * (1 - Math.exp(-(target > refs.fog.current ? 4 : 0.9) * dt));
    refs.gust.current = gustRef.current;
    refs.bloom.current = cleared && refs.fog.current > 0.85 ? Math.min(1, refs.bloom.current + dt / 2.6) : !cleared ? Math.max(0, refs.bloom.current - dt / 1.5) : refs.bloom.current;
  });
  return null;
}
