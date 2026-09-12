/**
 * #520（spec .studio/specs/2026-09-12-channel-mainline-measurement §3/§4，决议 #505）：
 * 前端测量模块——频道主链路三处黑盒埋点，与 read-metrics 同构的「模块级 sink + safeEmit」模式：
 *
 *  - 模块级 sink：默认开启（最小常驻版，这是与 read-metrics 生产恒 null 的差异）——
 *    HTTP sink 经既有 POST /api/v1/events 落 studio-events 事件流，不新增端点；
 *    测试模式（import.meta.env.MODE === 'test'）默认 null；setClientPerfSink(null) 整体关闭，
 *    关闭时每个埋点除一次判空外零开销、零行为变化。
 *  - safeEmit：sink 抛异常一律吞掉，测量路径永不外泄（同 read-metrics 先例）。
 *
 * 三个埋点（事件名统一 client.perf.* 前缀；关联字段用负载现成字段，不改 SSE 契约）：
 *  ① send_click      — composer 提交动作瞬间（ChannelInput.handleSend），点事件无耗时；
 *  ② receipt_render  — 回执消息 SSE 到达（useChannelMessages 记起点）→ 渲染完成
 *                      （ChannelDetailPage messages effect），含耗时 ms；
 *  ③ page_load       — 频道页进页 → 首屏消息渲染完成，含耗时 ms。
 */
import { api } from '../api';

export type ClientPerfEventType =
  | 'client.perf.send_click'
  | 'client.perf.receipt_render'
  | 'client.perf.page_load';

export interface ClientPerfPayload {
  channelId?: string;
  messageId?: string;
  workUnitId?: string | null;
  replyToId?: string | null;
  /** 耗时毫秒（send_click 为点事件，无此字段） */
  ms?: number;
}

export type ClientPerfSink = (type: ClientPerfEventType, payload: ClientPerfPayload) => void;

/** 默认 HTTP sink：经既有事件端点落 studio-events 事件流（fire-and-forget，失败静默）。 */
export function createHttpSink(): ClientPerfSink {
  return (type, payload) => {
    void api.post('/events', { type, source: 'web-client', payload: { ...payload } }).catch(() => {});
  };
}

/** 默认 sink：生产/开发 = HTTP sink（常驻开启）；测试模式 = null（spec §4：测试可整体关闭）。 */
function defaultSink(): ClientPerfSink | null {
  return import.meta.env.MODE === 'test' ? null : createHttpSink();
}

let sink: ClientPerfSink | null = defaultSink();

/** 设置/关闭测量 sink（null = 整体关闭）。 */
export function setClientPerfSink(next: ClientPerfSink | null): void {
  sink = next;
}

/** 恢复默认 sink（测试装配 mock 后复原用）。 */
export function resetClientPerfSink(): void {
  sink = defaultSink();
}

/** 测量绝不影响业务：sink 抛异常一律吞掉。 */
function safeEmit(type: ClientPerfEventType, payload: ClientPerfPayload): void {
  const s = sink;
  if (s === null) return;
  try {
    s(type, payload);
  } catch { /* 测量路径永不外泄 */ }
}

// ── 起点台账（模块级；emit 消费后即删，每条/每进页至多发一次）──
const marks = new Map<string, number>();
/** 台账上限：长期会话防膨胀（测量专用数据，超限整体丢弃可接受） */
const MARKS_CAP = 1000;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function perfMark(key: string): void {
  if (sink === null) return; // 关闭期间不记起点——重开后补渲染不误发
  if (marks.size >= MARKS_CAP) marks.clear();
  marks.set(key, now());
}

/** 取走起点（取后即删）；无起点（未标记/已消费）→ null。 */
function takeMark(key: string): number | null {
  const t0 = marks.get(key);
  if (t0 === undefined) return null;
  marks.delete(key);
  return t0;
}

/** 埋点①：composer 提交动作瞬间（ChannelInput.handleSend 守卫通过后调用）。 */
export function emitSendClick(input: { channelId?: string; replyToId?: string | null }): void {
  if (sink === null) return;
  safeEmit('client.perf.send_click', { channelId: input.channelId, replyToId: input.replyToId ?? null });
}

/** 埋点②起点：回执消息 SSE 到达（useChannelMessages 接线；已在列表的回声不记）。 */
export function markReceiptArrived(messageId: string): void {
  perfMark(`receipt:${messageId}`);
}

/** 埋点②终点：消息渲染完成（ChannelDetailPage messages effect 逐条调用；
 *  仅 SSE 标记过的消息发事件，每条至多一次）。 */
export function emitReceiptRendered(input: { messageId: string; channelId?: string; workUnitId?: string | null }): void {
  if (sink === null) return;
  const t0 = takeMark(`receipt:${input.messageId}`);
  if (t0 === null) return;
  safeEmit('client.perf.receipt_render', {
    channelId: input.channelId,
    messageId: input.messageId,
    workUnitId: input.workUnitId ?? null,
    ms: Math.max(0, now() - t0),
  });
}

/** 埋点③起点：频道页进页（ChannelDetailPage 挂载/切换频道）。 */
export function markPageEntry(channelId: string): void {
  perfMark(`page:${channelId}`);
}

/** 埋点③终点：首屏消息渲染完成（起点消费后不再发——每进页至多一次；
 *  空频道无首屏消息属正常，不发事件）。 */
export function emitPageFirstRender(channelId: string): void {
  if (sink === null) return;
  const t0 = takeMark(`page:${channelId}`);
  if (t0 === null) return;
  safeEmit('client.perf.page_load', { channelId, ms: Math.max(0, now() - t0) });
}
