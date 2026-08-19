// Channel 消息 meta 解析 — #264 人审卡片全灭修复
// 背景：后端 REST/SSE 出口 meta 为 object（shapeMessageData 已解析），前端原按 string 解析静默吞错。
// 双型兼容：object 直接取用；string 则 JSON.parse，解析失败回退 {}（与 NotificationBell 口径对齐）。

/** 卡片 meta：消息 meta 解析产物；cardData 形状随 cardType 而异，卡片内按需断言 */
export interface CardMeta {
  cardType?: string;
  status?: string;
  cardData?: Record<string, unknown>;
  projectPath?: string;
  requirementsDocId?: string;
  requirementId?: string;
  reqId?: string;
  pmoId?: string;
  error?: string;
  [key: string]: unknown;
}

/** meta 双型兼容——线上 REST/SSE 出口为 object（直接取用）；string 则 JSON.parse，解析失败回退 {} */
export function parseMeta(meta?: string | Record<string, unknown> | null): CardMeta {
  if (typeof meta === 'string') {
    try { return JSON.parse(meta || '{}'); } catch { return {}; }
  }
  return (meta ?? {}) as CardMeta;
}
