/**
 * 感測器訊號處理工具：低通濾波（防手抖）＋「持續時間 + 冷卻」的手勢防抖。
 *
 * 為什麼不用一般的 debounce(fn, ms)？
 * 感測器是每秒 60 次的連續訊號，一般 debounce 會讓「一直晃」永遠不觸發。
 * 手勢需要的是：條件「持續成立 N 毫秒」才算數（dwell），且觸發後「冷卻 M 毫秒」才能再觸發（cooldown）。
 */

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 一階低通濾波（指數移動平均），依實際時間差計算，不受感測器頻率影響 */
export class LowPass {
  private v: number | null = null;
  /** @param tauMs 時間常數，越大越平滑（越不受手抖影響，但反應越慢） */
  constructor(private tauMs: number) {}
  push(x: number, dtMs: number): number {
    if (this.v === null || !Number.isFinite(this.v)) {
      this.v = x;
      return x;
    }
    const k = 1 - Math.exp(-Math.max(dtMs, 0) / this.tauMs);
    this.v += (x - this.v) * k;
    return this.v;
  }
  get value(): number | null {
    return this.v;
  }
  reset() {
    this.v = null;
  }
}

/**
 * 遲滯（Hysteresis）＋持續時間判斷。
 * 例：叩首 enter = beta ≤ 55°，exit = beta ≥ 75°，兩個門檻中間的 20° 是緩衝帶，手抖不會來回跳。
 */
export class DwellLatch {
  private active = false;
  private candidateSince: number | null = null;
  constructor(
    private isEnter: (v: number) => boolean,
    private isExit: (v: number) => boolean,
    private dwellMs: number,
  ) {}
  /** 回傳 'enter' | 'exit' | null（只在狀態真正切換那一刻回傳） */
  update(v: number, now: number): 'enter' | 'exit' | null {
    const wantsFlip = this.active ? this.isExit(v) : this.isEnter(v);
    if (!wantsFlip) {
      this.candidateSince = null;
      return null;
    }
    if (this.candidateSince === null) this.candidateSince = now;
    if (now - this.candidateSince < this.dwellMs) return null;
    this.active = !this.active;
    this.candidateSince = null;
    return this.active ? 'enter' : 'exit';
  }
  get isActive() {
    return this.active;
  }
  reset() {
    this.active = false;
    this.candidateSince = null;
  }
}

/** 冷卻閘門：距離上次放行未滿 ms 就擋下 */
export class Cooldown {
  private last = -Infinity;
  constructor(private ms: number) {}
  tryPass(now: number): boolean {
    if (now - this.last < this.ms) return false;
    this.last = now;
    return true;
  }
}

/**
 * 取得「螢幕座標系」下的前後傾角（pitch）與左右歪斜（roll）。
 * 直式拿手機、螢幕面向自己、頂端朝天 → pitch ≈ 90°；頂端往前倒 → 變小，平放 → 0°。
 * 橫式時前後傾改由 gamma 反映（直立時 |gamma| ≈ 90°），左右歪斜改由 beta 反映。
 * 橫式在接近直立時 beta 會在 ±180° 附近跳動，所以 UI 仍建議「請直拿手機」。
 */
export function screenTilt(beta: number, gamma: number): { pitch: number; roll: number } {
  const angle = getScreenAngle();
  if (angle === 90 || angle === -90 || angle === 270) {
    const roll = Math.abs(beta) > 90 ? 180 - Math.abs(beta) : beta;
    return { pitch: Math.abs(gamma), roll };
  }
  if (angle === 180) return { pitch: -beta, roll: -gamma };
  return { pitch: beta, roll: gamma };
}

export const isPortrait = () => {
  const a = getScreenAngle();
  return a === 0 || a === 180;
};

export function getScreenAngle(): number {
  if (typeof window === 'undefined') return 0;
  const so = window.screen?.orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  // 舊版 iOS Safari
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

/** 手機是否「直立」：pitch 在 60°~120°，左右歪斜不超過 35° */
export function isUpright(pitch: number, roll: number): boolean {
  return pitch >= 60 && pitch <= 120 && Math.abs(roll) <= 35;
}
