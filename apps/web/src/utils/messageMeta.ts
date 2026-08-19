// Channel 消息 meta 解析 — #264 人审卡片全灭修复
// 背景：后端 REST/SSE 出口 meta 为 object（shapeMessageData 已解析），前端原按 string 解析静默吞错。
// 双型兼容：object 直接取用；string 则 JSON.parse，解析失败回退 {}（与 NotificationBell 口径对齐）。

/** #267（决策 #250 D3）NEED_INPUT 结构化选项卡选项形态（对齐后端 MessageMeta.options） */
export interface MetaOption {
  label: string;
  /** 副标题（归属问答场景 = 工程 path 消歧） */
  description?: string;
  /** 点选时作为回复发送的内容；缺省发送 label（归属问答场景 = 工程绝对路径，走直连通道） */
  value?: string;
}

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
  /** #267（决策 #250 D3）：NEED_INPUT 结构化选项卡；有 options 时渲染选项卡，无则单行回复框 fallback */
  options?: MetaOption[];
  /** #267（决策 #250 D3）预留多选钩子（v1 恒单选，点选即发送） */
  multiSelect?: boolean;
  [key: string]: unknown;
}

/** meta 双型兼容——线上 REST/SSE 出口为 object（直接取用）；string 则 JSON.parse，解析失败回退 {} */
export function parseMeta(meta?: string | Record<string, unknown> | null): CardMeta {
  if (typeof meta === 'string') {
    try { return JSON.parse(meta || '{}'); } catch { return {}; }
  }
  return (meta ?? {}) as CardMeta;
}
