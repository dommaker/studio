// Channel 消息 meta 解析 — #264 人审卡片全灭修复
// 背景：后端 REST/SSE 出口 meta 恒为 object（channel-message.service shapeMessageData 单点解析），
// 前端按 object 直读；string 形态无活写入方（存储层 JSON 字符串不出后端）。

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

/** meta 解析——线上 REST/SSE 出口恒为 object（后端 shapeMessageData 单点解析），直接取用；缺省回退 {} */
export function parseMeta(meta?: Record<string, unknown> | null): CardMeta {
  return (meta ?? {}) as CardMeta;
}
