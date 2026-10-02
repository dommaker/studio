// Events API — #180 事件检索（#60 决策 Q3a：GET /events 过滤 + 尾部倒读游标分页）
//
// 契约驱动迁移（2026-10 批次 5/7）：手抄 interface（StudioEventLevel/
// StudioEventItem/EventSearchResult）删除改 contract import；响应统一 `{ data }`
// 壳（原平铺），消费方解包 res.data → res.data.data。EventSearchParams 为请求侧
// 参数类型（非 wire 响应），保留本地。SSE /events/stream 不在契约范围，事件流
// payload 仍走本地解析器（见 websocketHooks）。
import type {
  StudioEventLevel,
  StudioEventItem,
  EventSearchResult,
} from '@dommaker/studio-contract';
import { api } from './index';

export type { StudioEventLevel, StudioEventItem, EventSearchResult };

interface EventSearchParams {
  type?: string;
  level?: StudioEventLevel;
  since?: string;
  until?: string;
  keyword?: string;
  workUnitId?: string;
  limit?: number;
  cursor?: string;
}

export const eventsApi = {
  /** 事件检索：level/until/keyword/type 过滤 + 游标分页 */
  search: (params: EventSearchParams) =>
    api.get<{ data: EventSearchResult }>('/events', { params }),
};
