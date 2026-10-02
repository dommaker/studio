// SSE 客户端本地类型（P3-a 自 api/websocketHooks.ts 迁出——api 层不声明导出类型）。
// /events/stream 信封不在 REST 契约范围（SSE 无 zod 正本），形状以服务端 events 模块实际下发为准。

/** SSE 事件信封（/events/stream 每行 data 解析后） */
export interface WebSocketMessage {
  event_id: string;
  event_type: string;
  timestamp: string;
  data: unknown;
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
