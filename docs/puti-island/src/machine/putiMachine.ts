/**
 * 清淨菩提島的流程狀態機（useReducer）
 *
 *   idle ──START──▶ askMic ──MIC_READY──▶ blowing ──CLEARED──▶ cleared ──CARD_CLOSED──▶ idle（今天已雲開）
 *                     │                      ▲
 *                     └──USE_TOUCH───────────┘   （拒絕授權、LINE 內建瀏覽器、沒有麥克風、自己選「按住吹氣」）
 *   任何進行中的狀態 ──ABORT──▶ idle（點到別座島、關掉資訊卡、切到背景）
 *
 * 需求裡的三個旗標可以從 phase 推出來：
 *   isMicReady = phase === 'blowing' && mode === 'mic'
 *   isBlowing  = useBlowDetection().isBlowing
 *   isCleared  = phase === 'cleared' || todayQuote != null
 */
import type { BodhiQuote } from '../types/quote';
import type { MicError } from '../hooks/useBlowDetection';

export type PutiPhase = 'idle' | 'askMic' | 'blowing' | 'cleared';
export type InputMode = 'mic' | 'touch';

export interface PutiState {
  phase: PutiPhase;
  mode: InputMode;
  /** 改用按住吹氣的原因（顯示提示） */
  fallback: MicError | 'manual' | null;
  /** 這次拿到的金句（cleared 之後） */
  quote: BodhiQuote | null;
  /** 金句面板是否展開 */
  cardOpen: boolean;
}

export type PutiAction =
  | { type: 'START' }
  | { type: 'MIC_READY' }
  | { type: 'USE_TOUCH'; reason: MicError | 'manual' }
  | { type: 'CLEARED'; quote: BodhiQuote }
  | { type: 'OPEN_CARD'; quote: BodhiQuote }
  | { type: 'CARD_CLOSED' }
  | { type: 'ABORT' };

export const initialPutiState: PutiState = { phase: 'idle', mode: 'mic', fallback: null, quote: null, cardOpen: false };

export function putiReducer(s: PutiState, a: PutiAction): PutiState {
  switch (a.type) {
    case 'START': return s.phase === 'idle' ? { ...initialPutiState, phase: 'askMic' } : s;
    case 'MIC_READY': return s.phase === 'askMic' ? { ...s, phase: 'blowing', mode: 'mic' } : s;
    case 'USE_TOUCH': return s.phase === 'askMic' || s.phase === 'blowing' ? { ...s, phase: 'blowing', mode: 'touch', fallback: a.reason } : s;
    case 'CLEARED': return s.phase === 'blowing' ? { ...s, phase: 'cleared', quote: a.quote } : s;   // 鎖定：之後的吹氣都不理
    case 'OPEN_CARD': return { ...s, quote: a.quote, cardOpen: true };
    case 'CARD_CLOSED': return { ...s, cardOpen: false, phase: s.phase === 'cleared' ? 'idle' : s.phase };
    case 'ABORT': return s.phase === 'askMic' || s.phase === 'blowing' ? { ...initialPutiState } : s;
    default: return s;
  }
}

/** 抽金句：優先給菩提冊裡還沒有的，才集得滿 */
export function pickQuote(all: BodhiQuote[], got: Record<number, string>): BodhiQuote {
  const left = all.filter((q) => !got[q.id]), pool = left.length ? left : all;
  const u = new Uint32Array(1); crypto.getRandomValues(u);
  return pool[u[0] % pool.length];
}
