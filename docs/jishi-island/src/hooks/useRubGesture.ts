import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 階段一「淨手洗心」：在葫蘆靈泉區域來回摩擦累積 2 秒。
 *
 * 用 Pointer Events（同時涵蓋 Touch 與滑鼠，桌機也能測），元素要加 CSS `touch-action: none`
 * 才不會被瀏覽器拿去捲動頁面。
 *
 * 規則：
 *  - 手指「有在移動」（速度 > minSpeed px/ms）的時間才算摩擦時間，按著不動不算。
 *  - 中斷超過 graceMs，已累積的進度會慢慢流失（每秒 decayPerSec），鼓勵一口氣洗完。
 */
export interface RubOptions {
  requiredMs?: number;
  minSpeed?: number;
  graceMs?: number;
  decayPerSec?: number;
  enabled: boolean;
  onStart?: () => void; // 開始摩擦（同時是使用者手勢 → 在這裡 unlock 音效、開水聲）
  onStop?: () => void;
  onProgress: (ratio: number) => void;
  onComplete: () => void;
}

export function useRubGesture({
  requiredMs = 2000,
  minSpeed = 0.15,
  graceMs = 250,
  decayPerSec = 0.35,
  enabled,
  onStart,
  onStop,
  onProgress,
  onComplete,
}: RubOptions) {
  const acc = useRef(0);
  const last = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastRubAt = useRef(0);
  const rubbing = useRef(false);
  const cb = useRef({ onStart, onStop, onProgress, onComplete });
  cb.current = { onStart, onStop, onProgress, onComplete };

  // 停手後進度流失（用 rAF，不靠 pointer 事件）
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;
      if (now - lastRubAt.current > graceMs && acc.current > 0) {
        if (rubbing.current) {
          rubbing.current = false;
          cb.current.onStop?.();
        }
        acc.current = Math.max(0, acc.current - requiredMs * decayPerSec * (dt / 1000));
        cb.current.onProgress(acc.current / requiredMs);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, graceMs, requiredMs, decayPerSec]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!enabled) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      last.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!enabled || !last.current) return;
      const p = last.current;
      const dt = e.timeStamp - p.t;
      if (dt <= 0) return;
      const speed = Math.hypot(e.clientX - p.x, e.clientY - p.y) / dt;
      last.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (speed < minSpeed) return;

      if (!rubbing.current) {
        rubbing.current = true;
        cb.current.onStart?.();
      }
      lastRubAt.current = performance.now();
      acc.current += Math.min(dt, 50); // 單次最多記 50ms，避免卡頓後一次跳很多
      const ratio = acc.current / requiredMs;
      cb.current.onProgress(Math.min(1, ratio));
      if (ratio >= 1) {
        rubbing.current = false;
        last.current = null;
        cb.current.onStop?.();
        cb.current.onComplete();
      }
    },
    [enabled, minSpeed, requiredMs],
  );

  const onPointerEnd = useCallback(() => {
    last.current = null;
  }, []);

  return {
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      style: { touchAction: 'none' as const },
    },
  };
}
