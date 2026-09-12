/**
 * HZ-028: Event Stream (SSE)
 *
 * GET /api/v1/events/stream — Server-Sent Events stream
 *
 * Query params:
 *   topics — comma-separated topic filter (executions, tasks, all)
 *   Last-Event-ID — reconnection support (standard SSE header)
 *
 * #491：Last-Event-ID 已真正消费——事件经 sse-replay-buffer 短窗口内存 buffer
 * （环形，id = 服务端单调 seq），重连时补发窗口内遗漏事件；窗口外的洞不补发，
 * 由前端 onReconnect 全量 refetch 兜底。
 *
 * Provides a simpler alternative to WebSocket for one-way server→client streaming.
 * Uses EventBus pub/sub (B0-002).
 */

import { Router, Request, Response } from 'express';
import { eventBus } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { SseReplayBuffer } from './sse-replay-buffer.js';
import { EXECUTION_STREAM_SSE_TYPE } from '../agents/loop/execution-step-events.js';

const router = Router();

/** #491：进程级 replay buffer（容量 500，约覆盖分钟级断线窗口；导出供测试锁定行为） */
export const sseReplayBuffer = new SseReplayBuffer(500);

interface SSEClient {
  id: string;
  res: Response;
  topics: Set<string>;
  lastEventId: string;
  /** heartbeat interval 句柄——背压断开时一并清除，防 write-after-end（#324 评审修复） */
  heartbeat?: NodeJS.Timeout;
}

const clients = new Map<string, SSEClient>();
let eventSubStarted = false;

/** event_type → SSE topic（纯前缀映射；导出供单测锁定映射表） */
export function getTopicFromEventType(eventType: string): string {
  if (eventType.startsWith('execution.')) return 'executions';
  if (eventType.startsWith('node.')) return 'nodes';
  if (eventType.startsWith('task.')) return 'tasks';
  if (eventType.startsWith('goal.')) return 'goals';
  if (eventType.startsWith('runtime.')) return 'executions';
  if (eventType.startsWith('knowledge.')) return 'knowledge';
  if (eventType.startsWith('workunit.')) return 'workunits';
  if (eventType.startsWith('channel.')) return 'channels';
  if (eventType.startsWith('requirement.')) return 'requirements';
  return 'all';
}

function ensureEventSubscription() {
  if (eventSubStarted) return;
  eventSubStarted = true;

  // #324：直订 eventBus（对象 payload，全程仅 sendSSE 内 1 次 JSON.stringify）
  eventBus.subscribe('events', (event: { event_type: string; event_id?: string }) => {
    // eventBus 精确匹配走 EventEmitter.emit，handler 抛异常会向上抛——内部 try/catch 护住
    try {
      const topic = getTopicFromEventType(event.event_type);
      // #524 P1-3（#516 项⑥）：stream chunk 不进 500 条共享 replay buffer——
      // 补发价值最低流量最大（Layer B 不落盘、前端纯内存、重连走全量 refetch 兜底），
      // 关键事件独占补发窗口；直播广播照常（id 取当前 seq，EventSource 游标语义不变）。
      const isStreamChunk = event.event_type === EXECUTION_STREAM_SSE_TYPE;
      // #491：先入 replay buffer（分配单调 seq 作为 SSE id 行），再广播
      const seq = isStreamChunk ? sseReplayBuffer.currentSeq : sseReplayBuffer.push(topic, event.event_type, event);
      for (const client of clients.values()) {
        if (client.topics.has('all') || client.topics.has(topic)) {
          // 转发完整信封（event_type/event_id/timestamp/data）——客户端按 event_type 分发
          sendSSE(client, event.event_type, event, String(seq));
        }
      }
    } catch (error) {
      logger.error({ error: String(error) }, '[SSE] Failed to process event');
    }
  });
  logger.info('[SSE] Event subscription established');
}

function sendSSE(client: SSEClient, eventType: string, data: any, eventId: string) {
  try {
    // `id:` 行 = 服务端单调 seq（#491，重连 Last-Event-ID 游标）；信封 event_id 留在 data 内。
    // 背压（#324 决策）：任一 write 返回 false（内核缓冲区满）即断开慢客户端，
    // 不让单个慢连接拖住整个广播循环；正常客户端不受影响。
    if (!client.res.write(`id: ${eventId}\n`)) return disconnectSlowClient(client);
    // 不写 `event:` 行（匿名事件）：EventSource.onmessage 只接收匿名事件，
    // 命名事件必须按类型逐个 addEventListener —— 前端统一从 data.event_type 分发。
    if (!client.res.write(`data: ${JSON.stringify(data)}\n\n`)) return disconnectSlowClient(client);
    client.lastEventId = eventId;
  } catch {
    // Client disconnected
    clients.delete(client.id);
  }
}

function disconnectSlowClient(client: SSEClient) {
  clients.delete(client.id);
  if (client.heartbeat) clearInterval(client.heartbeat);
  try { client.res.end(); } catch { /* already gone */ }
  logger.warn({ clientId: client.id }, '[SSE] Slow client disconnected (backpressure)');
}

/**
 * GET /api/v1/events/stream
 * SSE endpoint for real-time event streaming
 */
router.get('/stream', (req: Request, res: Response) => {
  const topicsParam = (req.query.topics as string) || 'all';
  const topics = new Set(topicsParam.split(',').map(t => t.trim()));
  const lastEventId = (req.headers['last-event-id'] as string) || '';

  const clientId = uuidv4();
  const client: SSEClient = { id: clientId, res, topics, lastEventId };
  clients.set(clientId, client);

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // #491：重连补发——Last-Event-ID 落在 buffer 窗口内则按 seq 升序补发遗漏事件
  // （按订阅 topics 过滤）；有洞（null）或游标无法解析则不补发，由前端
  // onReconnect 全量 refetch 兜底。补发必须在 connection.established 之前——
  // 后者以 currentSeq 为 id，先发会让 EventSource 游标越过补发事件。
  ensureEventSubscription();
  const missed = sseReplayBuffer.replay(lastEventId);
  if (missed) {
    for (const entry of missed) {
      if (!clients.has(clientId)) break; // 补发途中背压断开即停
      if (topics.has('all') || topics.has(entry.topic)) {
        sendSSE(client, entry.eventType, entry.data, String(entry.seq));
      }
    }
  }

  // Send initial connection event（id = 当前 seq：新连接游标就位，后续重连从断点续）
  sendSSE(client, 'connection.established', { clientId, topics: Array.from(topics) }, String(sseReplayBuffer.currentSeq));

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(clientId);
    }
  }, 30_000);
  client.heartbeat = heartbeat;

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    logger.debug({ clientId }, '[SSE] Client disconnected');
  });

  logger.info({ clientId, topics: Array.from(topics) }, '[SSE] Client connected');
});

/**
 * GET /api/v1/events/clients
 * List connected SSE clients (for debugging)
 */
router.get('/clients', (_req: Request, res: Response) => {
  const list = Array.from(clients.values()).map(c => ({
    id: c.id,
    topics: Array.from(c.topics),
    lastEventId: c.lastEventId,
  }));
  res.json({ clients: list, total: list.length });
});

export default router;
