/**
 * #491：SSE 短窗口内存 replay buffer（环形，按服务端分配的 seq 单调递增）。
 *
 * 断线/背压窗口内的事件在重连（Last-Event-ID）时按序补发；
 * 窗口外的洞不补发，由前端 onReconnect 全量 refetch 兜底（决策 9）。
 * 不改持久化存储——进程重启即清空，重启后前端同样走 refetch 兜底。
 */

export interface ReplayEntry {
  /** 服务端分配的单调递增序号，即 SSE `id:` 行（重连游标） */
  seq: number;
  /** getTopicFromEventType 映射结果，供重连时按客户端订阅 topics 过滤 */
  topic: string;
  eventType: string;
  /** 完整信封（event_type/event_id/timestamp/data）——客户端按信封/消息 id 幂等去重 */
  data: unknown;
}

export class SseReplayBuffer {
  private entries: ReplayEntry[] = [];
  private seq = 0;

  constructor(private readonly capacity = 500) {}

  /** 入队并返回分配的 seq（从 1 开始单调递增）；容量超限淘汰最老 */
  push(topic: string, eventType: string, data: unknown): number {
    const seq = ++this.seq;
    this.entries.push({ seq, topic, eventType, data });
    if (this.entries.length > this.capacity) this.entries.shift();
    return seq;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.entries.length;
  }

  /** buffer 内最老事件 seq；空 buffer 为 0 */
  get oldestSeq(): number {
    return this.entries[0]?.seq ?? 0;
  }

  /**
   * 取出 lastEventId 之后的遗漏事件（按 seq 升序）。
   * 返回 null = 有洞（lastEventId 早于 buffer 最老事件），调用方不补发；
   * lastEventId 无法解析（空串 / 旧版 uuid 游标）视为新连接，返回空数组。
   */
  replay(lastEventId: string): ReplayEntry[] | null {
    if (!/^\d+$/.test(lastEventId)) return [];
    const since = Number(lastEventId);
    if (since >= this.seq) return [];
    if (since < this.oldestSeq - 1) return null;
    return this.entries.filter(e => e.seq > since);
  }
}
