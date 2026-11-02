/**
 * 濟公活佛體感抽籤：狀態機（純函式，可單元測試）
 *
 *  purify ──PURIFY_DONE──▶ permission ──PERMISSION_RESULT(granted)──▶ bow
 *                              │                                        │ BOW ×3
 *                              └─(denied/unsupported)─▶ 改用按鈕模擬      ▼
 *  reading ◀──OPEN_SCROLL── drawn ◀──POUR── pour ◀──(progress=100)── shake ◀──START_SHAKE── ready
 *
 * 每個 action 只在「它所屬的階段」有效，其餘一律忽略 → 保證一定照順序完成。
 */

export type Phase =
  | 'purify' // 階段一：淨手洗心（摩擦葫蘆靈泉）
  | 'permission' // 淨手完成，等使用者點「開始參拜」（iOS 權限必須在點擊當下請求）
  | 'bow' // 階段二：誠心參拜（叩首三次）
  | 'ready' // 叩首完成，抽籤按鈕解鎖
  | 'shake' // 階段三：搖晃籤筒
  | 'pour' // 階段四：進度滿，等待向前傾倒
  | 'drawn' // 竹籤掉落動畫播放中
  | 'reading'; // 2D 籤詩卷軸展開

export type SensorPermission = 'unknown' | 'granted' | 'denied' | 'unsupported' | 'insecure';

export interface LotteryState {
  phase: Phase;
  /** 階段一 0~1 */
  purifyProgress: number;
  isPurified: boolean;
  bowCount: number;
  isBowed: boolean;
  isShaking: boolean;
  /** 階段三 0~100 */
  progress: number;
  /** 手機是否保持直立（搖晃與參拜時用來提示） */
  uprightOk: boolean;
  isDrawn: boolean;
  fortuneId: number | null;
  permission: SensorPermission;
  /** 沒有感測器（桌機、權限被拒）時改用按鈕模擬 */
  fallbackMode: boolean;
}

export type LotteryAction =
  | { type: 'PURIFY_PROGRESS'; value: number }
  | { type: 'PURIFY_DONE' }
  | { type: 'PERMISSION_RESULT'; result: SensorPermission }
  | { type: 'BOW' }
  | { type: 'START_SHAKE' }
  | { type: 'SHAKE_ADD'; amount: number }
  | { type: 'UPRIGHT'; ok: boolean }
  | { type: 'POUR'; fortuneId: number }
  | { type: 'OPEN_SCROLL' }
  | { type: 'RESET' };

export const BOWS_REQUIRED = 3;

export const initialLotteryState: LotteryState = {
  phase: 'purify',
  purifyProgress: 0,
  isPurified: false,
  bowCount: 0,
  isBowed: false,
  isShaking: false,
  progress: 0,
  uprightOk: true,
  isDrawn: false,
  fortuneId: null,
  permission: 'unknown',
  fallbackMode: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function lotteryReducer(s: LotteryState, a: LotteryAction): LotteryState {
  switch (a.type) {
    case 'PURIFY_PROGRESS':
      if (s.phase !== 'purify') return s;
      return { ...s, purifyProgress: clamp(a.value, 0, 1) };

    case 'PURIFY_DONE':
      if (s.phase !== 'purify') return s;
      return { ...s, phase: 'permission', purifyProgress: 1, isPurified: true };

    case 'PERMISSION_RESULT': {
      if (s.phase !== 'permission') return s;
      const fallbackMode = a.result !== 'granted';
      return { ...s, phase: 'bow', permission: a.result, fallbackMode };
    }

    case 'BOW': {
      if (s.phase !== 'bow') return s;
      const bowCount = s.bowCount + 1;
      const isBowed = bowCount >= BOWS_REQUIRED;
      return { ...s, bowCount, isBowed, phase: isBowed ? 'ready' : 'bow' };
    }

    case 'START_SHAKE':
      if (s.phase !== 'ready') return s;
      return { ...s, phase: 'shake', isShaking: true, progress: 0 };

    case 'SHAKE_ADD': {
      if (s.phase !== 'shake') return s;
      const progress = clamp(s.progress + a.amount, 0, 100);
      if (progress >= 100) return { ...s, progress: 100, isShaking: false, phase: 'pour' };
      return { ...s, progress };
    }

    case 'UPRIGHT':
      return s.uprightOk === a.ok ? s : { ...s, uprightOk: a.ok };

    case 'POUR':
      if (s.phase !== 'pour') return s;
      return { ...s, phase: 'drawn', isDrawn: true, fortuneId: a.fortuneId };

    case 'OPEN_SCROLL':
      if (s.phase !== 'drawn') return s;
      return { ...s, phase: 'reading' };

    case 'RESET':
      // 保留權限結果，再抽一次不用重新授權；但要重新淨手、參拜
      return { ...initialLotteryState, permission: s.permission, fallbackMode: s.fallbackMode };

    default:
      return s;
  }
}
