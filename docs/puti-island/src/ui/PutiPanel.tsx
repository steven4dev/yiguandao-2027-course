/**
 * UI 層（DOM，疊在 Canvas 上）：資訊卡裡的步驟、麥克風提示、音量條／進度條、按住吹氣、上方的破關金句面板
 */
import type { BlowDetection } from '../hooks/useBlowDetection';
import type { PutiState } from '../machine/putiMachine';
import type { BodhiQuote } from '../types/quote';

const WHY: Record<string, string> = {
  denied: '沒有取得麥克風權限，改用「按住吹氣」也能吹散雲霧。想用麥克風，請到瀏覽器的網站設定允許麥克風，再重新整理。',
  inapp: 'LINE、Facebook 內建的瀏覽器不能用麥克風。可以點右上角選「用預設瀏覽器開啟」，或直接用下面的「按住吹氣」。',
  nomic: '這台裝置找不到麥克風，改用「按住吹氣」。',
  unsupported: '這個瀏覽器不支援麥克風，改用「按住吹氣」。',
  insecure: '要在 https 網址才能用麥克風，改用「按住吹氣」。',
  error: '麥克風打不開，改用「按住吹氣」。',
  ended: '麥克風中斷了，改用「按住吹氣」繼續。',
  manual: '',
};

export function Steps({ step }: { step: number }) {
  return (
    <ol className="steps">
      {['開啟麥克風', '長吹一口氣', '雲開見日'].map((n, i) => <li key={n} className={i < step ? 'done' : i === step ? 'now' : ''}><i>{i < step ? '✓' : i + 1}</i>{n}</li>)}
    </ol>
  );
}

/** 階段一：請開啟麥克風 */
export function MicPrompt({ onMic, onTouch, onCancel, waiting }: { onMic: () => void; onTouch: () => void; onCancel: () => void; waiting: boolean }) {
  return (
    <>
      <Steps step={0} />
      <p className="say">請開啟麥克風，準備吹散無明 🎙️<br />按下按鈕後，瀏覽器會問要不要允許使用麥克風，請按「允許」。</p>
      <button className="btn" type="button" onClick={onMic} disabled={waiting}>🎙️ 開啟麥克風</button>
      {waiting && <p className="hint" aria-live="polite">等待麥克風權限⋯</p>}
      <button className="mini" type="button" onClick={onTouch}>不方便出聲？改用「按住吹氣」</button>
      <p className="note">🔒 只在這台裝置上即時分析音量，不錄音、不上傳；吹完會自動關掉麥克風。</p>
      <button className="cancel" type="button" onClick={onCancel}>✕ 先不吹了</button>
    </>
  );
}

/** 階段二：吹氣（音量條＋門檻線、進度條、即時提示；或按住吹氣） */
export function BlowMeter({ blow, state, onTouch, onCancel }: { blow: BlowDetection; state: PutiState; onTouch: () => void; onCancel: () => void }) {
  const mic = state.mode === 'mic';
  const live = blow.isBlowing ? '🌬️ 吹散中⋯ 繼續吹！'
    : mic && blow.reason === 'voice' ? '聽起來像說話聲，試試「呼——」的吹氣聲'
    : blow.progress > 0 ? '雲霧慢慢聚回來了，再吹一口！' : '';
  const hold = (on: boolean) => blow.setManualBlow(on);
  return (
    <>
      <Steps step={1} />
      {state.fallback && WHY[state.fallback] && <p className="hint">{WHY[state.fallback]}</p>}
      {mic && blow.status === 'calibrating'
        ? <p className="say">麥克風開好了。先別吹，聽一下周圍的聲音⋯</p>
        : <p className="say">{mic ? '請對著麥克風長吹一口氣 🌬️ 嘴巴靠近手機下緣的麥克風孔，像吹蠟燭那樣「呼——」一直吹；一口不夠，換口氣再吹。' : '按住下面的雲朵吹氣，雲霧就會被吹散；放開就停。'}</p>}
      {mic
        ? <div className={`level${blow.isBlowing ? ' on' : ''}`} aria-hidden="true"><i style={{ width: `${blow.level * 100}%` }} /><b style={{ left: `${blow.gate * 100}%` }} /><em>你的吹氣聲</em></div>
        : <button type="button" className="pad" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); hold(true); }} onPointerUp={() => hold(false)} onPointerCancel={() => hold(false)}
            onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); hold(true); } }} onKeyUp={() => hold(false)} onContextMenu={(e) => e.preventDefault()}>
            <span>🌬️</span><span>按住這裡　呼～</span>
          </button>}
      <div className="meter" role="progressbar" aria-label="雲霧吹散進度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(blow.progress)}><i style={{ width: `${blow.progress}%` }} /></div>
      <p className="hint live" aria-live="polite">{live}</p>
      {mic && <button className="mini" type="button" onClick={onTouch}>吹不動？改用「按住吹氣」</button>}
      <button className="cancel" type="button" onClick={onCancel}>✕ 先不吹了</button>
    </>
  );
}

/** 階段三：畫面上方展開的破關金句面板 */
export function QuotePanel({ quote, open, again, demo, shareUrl, onClose }: { quote: BodhiQuote | null; open: boolean; again: boolean; demo: boolean; shareUrl: string; onClose: () => void }) {
  if (!quote) return null;
  const text = `🪷 我在全真群島・清淨菩提島吹散了雲霧，雲開見日\n「${quote.quote}」——${quote.title}\n一起來吹散無明：${shareUrl}`;
  return (
    <div className={`ptcard${open ? ' on' : ''}`} role="dialog" aria-modal="false" aria-labelledby="ptTitle" hidden={!open}>
      <span className="eyebrow">🪷 雲開見日・破關金句</span>
      <h2 id="ptTitle">{quote.title}</h2>
      <blockquote className="quote">{quote.quote}</blockquote>
      <h3>破關啟示</h3><p>{quote.reflection}</p>
      {demo && <p className="demo">示範慈語・正式慈語由道場審定後更換</p>}
      <div className="btns">
        <a className="line" href={`https://line.me/R/share?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">分享到 LINE</a>
        <button type="button" onClick={onClose}>🙏 {again ? '收起來' : '收進菩提冊'}</button>
      </div>
    </div>
  );
}
