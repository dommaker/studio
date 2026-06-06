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

// ── SSE: Knowledge event stream ──

knowledgeServiceRoutes.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emitter = (knowledgeService as any).deps?.eventEmitter;
  if (!emitter) {
    res.write('data: {"type":"error","message":"EventEmitter not available"}\n\n');
    res.end();
    return;
  }

  const onEvent = (event: { type: string; data: unknown }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  emitter.on('knowledge', onEvent);

  req.on('close', () => {
    emitter.off('knowledge', onEvent);
  });
});
