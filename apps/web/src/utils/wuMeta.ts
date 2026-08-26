// WU metadata JSON 解析唯一出口（#358：4 处逐字 try/catch 拷贝收口，模式对齐 #264 utils/messageMeta）。
// 空值/坏 JSON → {}（静默吞错与原各拷贝一致——WU metadata 为展示辅助数据，坏数据不阻断渲染）。

/** 解析 WU metadata；调用方经泛型按消费字段断言形态（其余字段透传） */
export function parseWuMeta<T extends object = Record<string, unknown>>(metadata: string | null | undefined): T {
  try { return JSON.parse(metadata || '{}') as T; } catch { return {} as T; }
}
