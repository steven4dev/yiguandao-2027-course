/**
 * 清淨菩提島：破關金句的資料結構
 * 對應原生版 islands/index.html 的 PT_QUOTES（欄位完全一樣，可以直接共用 JSON）
 */
export interface BodhiQuote {
  /** 獨立編號（1 起算，不重複；菩提冊用它記錄拿過哪幾句） */
  id: number;
  /** 境界名稱，例如「雲開見日」「清淨無染」（4 個字左右，會顯示在菩提冊格子上） */
  title: string;
  /** 仙佛金句（正式上線前需由道場審定，並註明出處） */
  quote: string;
  /** 破關啟示：白話解說，針對現代人的心境引導 */
  reflection: string;
}

/** 這支手機的紀錄（localStorage：islands-puti） */
export interface BodhiRecord {
  v: 1;
  /** 最近一次雲開見日的日期（台灣時間 YYYY-MM-DD） */
  day: string;
  /** 那一天拿到的金句 id */
  today: number;
  /** 菩提冊：金句 id → 第一次拿到的日期 */
  got: Record<number, string>;
}

/** JSON Schema（給後台、試算表匯入或 CMS 驗證用） */
export const BODHI_QUOTE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'BodhiQuote',
  type: 'object',
  required: ['id', 'title', 'quote', 'reflection'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1 },
    title: { type: 'string', minLength: 2, maxLength: 8 },
    quote: { type: 'string', minLength: 4, maxLength: 80 },
    reflection: { type: 'string', minLength: 10, maxLength: 240 },
  },
} as const;
