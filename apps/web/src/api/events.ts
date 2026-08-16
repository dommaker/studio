// Events API — #180 事件检索（#60 决策 Q3a：GET /events 过滤 + 尾部倒读游标分页）
import { api } from './index';

/** 事件级别（envelope 可选字段；缺省 info） */
export type StudioEventLevel = 'debug' | 'info' | 'warning' | 'critical';

export interface StudioEventItem {
  type: string;
  source?: string;
  level?: StudioEventLevel;
  /** JSON 字符串（服务端落盘形态） */
  payload?: string;
  createdAt?: string;
}

export interface EventSearchParams {
  type?: string;
  level?: StudioEventLevel;
  since?: string;
  until?: string;
  keyword?: string;
  workUnitId?: string;
  limit?: number;
  cursor?: string;
}

export interface EventSearchResult {
  events: StudioEventItem[];
  /** 本页条数 */
  total: number;
  /** 续翻游标；null = 没有更旧的事件 */
  nextCursor: string | null;
}

export const eventsApi = {
  /** 事件检索：level/until/keyword/type 过滤 + 游标分页 */
  search: (params: EventSearchParams) =>
    api.get<EventSearchResult>('/events', { params }),
};
