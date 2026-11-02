import type { SensorPermission } from '../machine/lotteryMachine';

type PermissionCapable = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

/**
 * 請求陀螺儀＋加速度計權限。
 *
 * iOS 13+ 規定：
 *  1. 必須是 HTTPS（isSecureContext）。
 *  2. requestPermission() 必須在「使用者點擊（click / touchend）」的同一個事件處理函式中『同步』呼叫，
 *     中間不能先 await 別的東西，否則會丟 NotAllowedError。
 *     → 所以這裡先同步把兩個 requestPermission() 都呼叫出去，拿到 Promise 後才 await。
 *  3. 同一頁面使用者按過「不允許」後，再呼叫只會直接回 denied，要請使用者重新整理或到設定開啟。
 * Android Chrome / 桌機：沒有 requestPermission，直接視為 granted（是否真的有資料要另外偵測）。
 */
export function requestSensorPermission(): Promise<SensorPermission> {
  if (typeof window === 'undefined') return Promise.resolve('unsupported');
  if (!window.isSecureContext) return Promise.resolve('insecure');

  const DOE = (window as unknown as { DeviceOrientationEvent?: PermissionCapable }).DeviceOrientationEvent;
  const DME = (window as unknown as { DeviceMotionEvent?: PermissionCapable }).DeviceMotionEvent;
  if (!DOE && !DME) return Promise.resolve('unsupported');

  const pending: Promise<string>[] = [];
  try {
    // ⚠️ 兩個都要在這一行同步呼叫，不能 await 完一個再叫另一個
    if (typeof DOE?.requestPermission === 'function') pending.push(DOE.requestPermission());
    if (typeof DME?.requestPermission === 'function') pending.push(DME.requestPermission());
  } catch {
    return Promise.resolve('denied');
  }
  if (pending.length === 0) return Promise.resolve('granted');

  return Promise.all(pending)
    .then((r): SensorPermission => (r.every((x) => x === 'granted') ? 'granted' : 'denied'))
    .catch((): SensorPermission => 'denied');
}

/**
 * 有些桌機／Android 平板會「有事件但值永遠是 null」。
 * 授權後等一小段時間，確認真的收得到數值，收不到就切換按鈕模擬模式。
 */
export function probeSensorData(timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('deviceorientation', onOri);
      clearTimeout(t);
      resolve(ok);
    };
    const onOri = (e: DeviceOrientationEvent) => {
      if (e.beta !== null && e.gamma !== null) finish(true);
    };
    const t = setTimeout(() => finish(false), timeoutMs);
    window.addEventListener('deviceorientation', onOri);
  });
}
