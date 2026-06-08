/**
 * HZ-028: Event Stream (SSE)
 *
 * GET /api/v1/events/stream — Server-Sent Events stream
 *
 * Query params:
 *   topics — comma-separated topic filter (executions, tasks, meetings, workflows, all)
 *   Last-Event-ID — reconnection support (standard SSE header)
 *
 * Provides a simpler alternative to WebSocket for one-way server→client streaming.
 * Uses EventBus pub/sub (B0-002).
 */

import { Router, Request, Response } from 'express';
import { eventStore } from '../../core/event-store.js';
import type { EventStore } from '../../core/event-store.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

const router = Router();

interface SSEClient {
  id: string;
  res: Response;
  topics: Set<string>;
  lastEventId: string;
}

const clients = new Map<string, SSEClient>();
let eventSubStarted = false;

function getTopicFromEventType(eventType: string): string {
  if (eventType.startsWith('workflow.')) return 'workflows';
  if (eventType.startsWith('execution.')) return 'executions';
  if (eventType.startsWith('node.')) return 'nodes';
  if (eventType.startsWith('task.')) return 'tasks';
  if (eventType.startsWith('meeting.')) return 'meetings';
  if (eventType.startsWith('goal.')) return 'goals';
  if (eventType.startsWith('runtime.')) return 'executions';
  if (eventType.startsWith('knowledge.')) return 'knowledge';
  return 'all';
}

function ensureEventSubscription() {
  if (eventSubStarted) return;
  eventSubStarted = true;

  eventStore.subscribe('events', (message: string) => {
    try {
      const event = JSON.parse(message);
      const topic = getTopicFromEventType(event.event_type);
      for (const client of clients.values()) {
        if (client.topics.has('all') || client.topics.has(topic)) {
          sendSSE(client, event.event_type, event.data, event.event_id);
        }
      }
    } catch (error) {
      logger.error({ error: String(error) }, '[SSE] Failed to process event');
    }
  });
  logger.info('[SSE] Event subscription established');
}

function sendSSE(client: SSEClient, eventType: string, data: any, eventId?: string) {
  try {
    const id = eventId || uuidv4();
    client.res.write(`id: ${id}\n`);
    client.res.write(`event: ${eventType}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    client.lastEventId = id;
  } catch {
    // Client disconnected
    clients.delete(client.id);
  }
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

  // Send initial connection event
  sendSSE(client, 'connection.established', { clientId, topics: Array.from(topics) });

  ensureEventSubscription();

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      clients.delete(clientId);
    }
  }, 30_000);

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
