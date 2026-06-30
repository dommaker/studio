// Trigger Routes — REST API for trigger management (3.28c-4)
import { Router } from 'express';
import { TriggerStore } from './trigger-store.js';
import { getTriggerScheduler } from './trigger-registry.js';
import type { TriggerConfig } from './trigger.types.js';

const router = Router();
const store = new TriggerStore();
const scheduler = getTriggerScheduler(store); // Singleton — shared with AgentLoop

/** GET /api/triggers — list all triggers */
router.get('/', (_req, res) => {
  const storeTriggers = store.list();
  const states = scheduler.getStates();
  const stateMap = new Map(states.map(s => [s.config.id, s]));

  // Merge: store triggers + scheduler-only triggers (system defaults)
  const seenIds = new Set<string>();
  const result: Array<TriggerConfig & { _state: { lastFiredAt: Date | null; errorCount: number } }> = [];

  // 1. Store triggers (user-defined + persisted)
  for (const t of storeTriggers) {
    seenIds.add(t.id);
    result.push({
      ...t,
      _state: {
        lastFiredAt: stateMap.get(t.id)?.lastFiredAt || null,
        errorCount: stateMap.get(t.id)?.errorCount || 0,
      },
    });
  }

  // 2. Scheduler-only triggers (system defaults not persisted to store)
  for (const state of states) {
    if (!seenIds.has(state.config.id)) {
      result.push({
        ...state.config,
        _state: {
          lastFiredAt: state.lastFiredAt || null,
          errorCount: state.errorCount || 0,
        },
      });
    }
  }

  res.json({ triggers: result, schedulerRunning: scheduler.isRunning() });
});

/** GET /api/triggers/:id — get single trigger */
router.get('/:id', (req, res) => {
  const trigger = store.get(req.params.id);
  if (!trigger) {
    res.status(404).json({ error: 'Trigger not found' });
    return;
  }
  res.json(trigger);
});

/** POST /api/triggers — create or update trigger */
router.post('/', (req, res) => {
  try {
    const config = req.body as TriggerConfig;
    store.save(config);
    scheduler.loadTriggers();
    res.status(201).json({ ok: true, id: config.id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** DELETE /api/triggers/:id — delete trigger */
router.delete('/:id', (req, res) => {
  const deleted = store.delete(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Trigger not found' });
    return;
  }
  scheduler.loadTriggers();
  res.json({ ok: true });
});

/** GET /api/triggers/:id/logs — get scheduler logs for a trigger */
router.get('/:id/logs', (req, res) => {
  const logs = scheduler.getLogs().filter(l => l.triggerId === req.params.id);
  res.json({ logs });
});

/** GET /api/triggers/status — scheduler status */
router.get('/status', (_req, res) => {
  res.json({
    running: scheduler.isRunning(),
    triggerCount: scheduler.getStates().length,
    logCount: scheduler.getLogs().length,
  });
});

export { router as triggerRouter, scheduler };
