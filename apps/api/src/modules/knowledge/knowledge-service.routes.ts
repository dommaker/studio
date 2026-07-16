/**
 * KnowledgeService HTTP API + SSE
 *
 * Exposes KnowledgeService capabilities over HTTP.
 * Mounted at /api/v1/knowledge-service
 */

import { Router } from 'express';
import { knowledgeService } from './knowledge-service.js';
import { logger } from '@dommaker/studio-shared';

export const knowledgeServiceRoutes = Router();

// Request logging middleware
knowledgeServiceRoutes.use((req, _res, next) => {
  logger.info('[KnowledgeService API]', { method: req.method, path: req.path });
  next();
});

// ── Query ──

knowledgeServiceRoutes.get('/stats', (_req, res) => {
  try {
    const stats = knowledgeService.getStats();
    res.json(stats);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: _req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/search', async (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q) return res.status(400).json({ error: 'q is required' });
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 50) : 10;
    const results = await knowledgeService.search(q, { limit });
    res.json({ results, total: results.length });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/entries', async (req, res) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.type) filter.types = String(req.query.type).split(',');
    if (req.query.tags) filter.tags = String(req.query.tags).split(',');
    if (req.query.limit) filter.limit = Math.min(Number(req.query.limit), 100);
    if (req.query.offset) filter.offset = Number(req.query.offset);
    const entries = await knowledgeService.list(filter as any);
    res.json({ entries, total: entries.length });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/entries/:id', async (req, res) => {
  try {
    const entry = await knowledgeService.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/entries', async (req, res) => {
  try {
    const entry = req.body;
    if (!entry.id || !entry.type || !entry.title || !entry.content) {
      return res.status(400).json({ error: 'id, type, title, content required' });
    }
    await knowledgeService.create(entry);
    res.status(201).json({ success: true, id: entry.id });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.put('/entries/:id', async (req, res) => {
  try {
    const updated = await knowledgeService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.delete('/entries/:id', async (req, res) => {
  try {
    const deleted = await knowledgeService.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/entries/stats', async (_req, res) => {
  try {
    const stats = knowledgeService.getStats();
    const health = await knowledgeService.getHealthReport();
    res.json({ ...stats, healthScore: (health as any).healthScore });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: '/entries/stats', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── Produce ──

knowledgeServiceRoutes.post('/pattern', async (req, res) => {
  try {
    const { type, title, content, tags } = req.body;
    if (!type || !title || !content) {
      return res.status(400).json({ error: 'type, title, content required' });
    }
    await knowledgeService.recordPattern({ type, title, content, tags: tags || [] });
    res.status(201).json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/incident', async (req, res) => {
  try {
    const { title, content, severity, tags } = req.body;
    if (!title || !content || !severity) {
      return res.status(400).json({ error: 'title, content, severity required' });
    }
    await knowledgeService.recordIncident({ title, content, severity, tags: tags || [] });
    res.status(201).json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/trend', async (req, res) => {
  try {
    const { title, content, metric, tags } = req.body;
    if (!title || !content || !metric) {
      return res.status(400).json({ error: 'title, content, metric required' });
    }
    await knowledgeService.recordTrend({ title, content, metric, tags: tags || [] });
    res.status(201).json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── Measure ──

knowledgeServiceRoutes.get('/health', async (_req, res) => {
  try {
    const report = await knowledgeService.getHealthReport();
    res.json(report);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: '/health', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/flywheel', async (_req, res) => {
  try {
    const metrics = await knowledgeService.getFlywheelMetrics();
    res.json(metrics);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: '/flywheel', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/audit', async (_req, res) => {
  try {
    const report = await knowledgeService.getAuditReport();
    res.json(report);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: '/audit', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.get('/analyst-accuracy', async (_req, res) => {
  try {
    const accuracy = await knowledgeService.getAnalystAccuracy();
    res.json(accuracy);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: '/analyst-accuracy', error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── Consume ──

knowledgeServiceRoutes.post('/inject-context', async (req, res) => {
  try {
    const { agentType, tags, maxTokens, includeRules } = req.body;
    if (!agentType) return res.status(400).json({ error: 'agentType required' });
    const result = await knowledgeService.injectContext(agentType, { tags, maxTokens, includeRules });
    res.json({ context: result.prompt, injectedIds: result.injectedIds });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/match-resolutions', async (req, res) => {
  try {
    const { problem } = req.body;
    if (!problem) return res.status(400).json({ error: 'problem required' });
    const result = await knowledgeService.matchResolutions(problem);
    res.json(result);
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── Track ──

knowledgeServiceRoutes.post('/record-outcome', async (req, res) => {
  try {
    const { executionId, agentType, consumedKnowledge, success, details, timestamp, mode } = req.body;
    if (!executionId || !agentType || success === undefined) {
      return res.status(400).json({ error: 'executionId, agentType, success required' });
    }
    await knowledgeService.recordOutcome({
      executionId, agentType, consumedKnowledge: consumedKnowledge || [],
      success, details: details || '', timestamp: timestamp || new Date().toISOString(), mode,
    });
    res.status(201).json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── Lifecycle ──

knowledgeServiceRoutes.post('/promote', async (req, res) => {
  try {
    const { entryId } = req.body;
    if (!entryId) return res.status(400).json({ error: 'entryId required' });
    await knowledgeService.promote(entryId);
    res.json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/decay', async (req, res) => {
  try {
    const { entryId } = req.body;
    if (!entryId) return res.status(400).json({ error: 'entryId required' });
    await knowledgeService.decay(entryId);
    res.json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

knowledgeServiceRoutes.post('/merge', async (req, res) => {
  try {
    const { sourceId, targetId } = req.body;
    if (!sourceId || !targetId) return res.status(400).json({ error: 'sourceId, targetId required' });
    await knowledgeService.merge(sourceId, targetId);
    res.json({ success: true });
  } catch (e: any) {
    logger.error('[KnowledgeService API]', { path: req.path, error: String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ── SSE: Bridge KnowledgeService events to general EventStore ──
// Knowledge events are now available at /api/v1/events/stream?topics=knowledge
// This endpoint redirects to the general SSE stream.

knowledgeServiceRoutes.get('/events', (_req, res) => {
  res.status(301).json({
    message: 'Knowledge events are now available at /api/v1/events/stream?topics=knowledge',
    url: '/api/v1/events/stream?topics=knowledge',
  });
});

// One-time bridge: subscribe KnowledgeService EventEmitter → EventStore
let bridgeInitialized = false;
export function initKnowledgeEventBridge(eventStore: { publish: (ch: string, msg: string) => Promise<void> }) {
  if (bridgeInitialized) return;
  bridgeInitialized = true;

  const emitter = (knowledgeService as any).deps?.eventEmitter;
  if (!emitter) {
    logger.warn('[KnowledgeService] EventEmitter not available, bridge not started');
    return;
  }

  emitter.on('knowledge', (event: { type: string; data: unknown }) => {
    eventStore.publish('events', JSON.stringify({
      event_type: `knowledge.${event.type}`,
      payload: event.data,
      timestamp: new Date().toISOString(),
    })).catch((err: unknown) => logger.warn('[KnowledgeService] EventBridge publish failed', { error: String(err) }));
  });

  logger.info('[KnowledgeService] Event bridge initialized → EventStore');
}
