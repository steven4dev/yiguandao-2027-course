/** 籤詩分類 */
export type FortuneType = '修心' | '人際' | '解憂' | '求職';

/** 一支籤 */
export interface Fortune {
  /** 籤號（1 起算，對應竹籤上刻的號碼） */
  id: number;
  /** 分類 */
  type: FortuneType;
  /** 籤頭，例如「反觀內省籤」 */
  title: string;
  /** 詩云：四句聯，固定四句 */
  poem: readonly [string, string, string, string];
  /** 濟公老師慈語解籤（白話文） */
  explanation: string;
  /** 修心妙方：一句可以當天就做到的日常實踐 */
  action: string;
}

/** 對應的 JSON Schema（給後台或 Google 試算表匯出時驗證用） */
export const FORTUNE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'jishi-island/fortune.schema.json',
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'type', 'title', 'poem', 'explanation', 'action'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      type: { enum: ['修心', '人際', '解憂', '求職'] },
      title: { type: 'string', minLength: 2, maxLength: 12 },
      poem: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: { type: 'string', minLength: 4, maxLength: 12 },
      },
      explanation: { type: 'string', minLength: 10 },
      action: { type: 'string', minLength: 2, maxLength: 40 },
    },
  },
} as const;
