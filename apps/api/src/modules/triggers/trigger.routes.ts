// Trigger Routes — REST API for trigger management (3.28c-4)
import { Router } from 'express';
import * as fs from 'fs';
import { TriggerStore } from './trigger-store.js';
import { getTriggerScheduler } from './trigger-registry.js';
import { executeCreateAction, executeExecuteAction } from './trigger-action.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
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

/**
 * GET /api/triggers/costs?days=N — 按任务聚合 token 成本（手动触发按钮的成本展示）
 * workunit:tokens 按 payload.triggerId 求和（billedTokens 优先，旧事件退回 totalTokens）；
 * system:tokens 按事件 source 统计调用次数与 token（usage 缺失时 tokens 为 0，calls 仍准确）。
 * 注意：必须注册在 GET /:id 之前，否则被 :id 捕获。
 */
router.get('/costs', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const byTrigger: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const callsBySource: Record<string, number> = {};
  try {
    // 与 agent-loop 同一约定：STUDIO_EVENTS_JSONL 可覆盖（测试隔离），缺省走 studio-log-path
    const eventsFile = process.env.STUDIO_EVENTS_JSONL || resolveStudioLogFile('studio-events.jsonl');
    if (fs.existsSync(eventsFile)) {
      for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
        if (!line) continue;
        let e: { type?: string; source?: string; createdAt?: string; payload?: unknown };
        try { e = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(e.createdAt ?? '');
        if (!Number.isFinite(ts) || ts < since) continue;
        let payload: Record<string, unknown> | null = null;
        try { payload = JSON.parse(String(e.payload)); } catch { continue; }
        if (e.type === 'workunit:tokens' && typeof payload.triggerId === 'string') {
          const t = Number(payload.billedTokens ?? payload.totalTokens ?? 0) || 0;
          byTrigger[payload.triggerId] = (byTrigger[payload.triggerId] || 0) + t;
        } else if (e.type === 'system:tokens') {
          const src = e.source || 'system-executor';
          callsBySource[src] = (callsBySource[src] || 0) + 1;
          const t = (Number(payload.inputTokens) || 0) + (Number(payload.outputTokens) || 0);
          bySource[src] = (bySource[src] || 0) + t;
        }
      }
    }
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
    return;
  }
  res.json({ days, byTrigger, bySource, callsBySource });
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

/**
 * POST /api/triggers/:id/fire — 手动触发（「配不上自动化、但值得一个按钮」的入口）
 * - 不检查 enabled：已停用任务手动跑是明确意图（响应带 wasDisabled 提示）
 * - CREATE 不传 dedupeWithinMinute：B3 同分钟去重只约束 SCHEDULE 自动路径，手动连点不去重
 * - config 双源查找：yaml store + scheduler 内存（系统默认触发器不落 store）
 */
router.post('/:id/fire', async (req, res) => {
  try {
    const id = req.params.id;
    const config = store.get(id) ?? scheduler.getStates().find(s => s.config.id === id)?.config;
    if (!config) {
      res.status(404).json({ error: { message: `Trigger not found: ${id}` } });
      return;
    }
    const wasDisabled = config.enabled === false;
    if (config.action.type === 'CREATE') {
      const workUnit = await executeCreateAction(config.action, config.id);
      res.json({ fired: true, wasDisabled, workUnit });
      return;
    }
    if (config.action.type === 'EXECUTE') {
      await executeExecuteAction(config.action, { manual: true });
      res.json({ fired: true, wasDisabled });
      return;
    }
    res.status(400).json({ error: { message: `Unsupported action type: ${config.action.type}` } });
  } catch (err) {
    res.status(500).json({ error: { message: (err as Error).message } });
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
