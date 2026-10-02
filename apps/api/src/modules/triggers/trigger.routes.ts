// Trigger Routes — REST API for trigger management (3.28c-4)
//
// 契约驱动迁移（2026-10 批次 3/7）：全部端点走 core/http.ts defineRoute——
// POST / 形状校验收进 zod（id/name/enabled/scope 等缺省原 store validateTrigger 400，
// 现 zod 提前 400；语义校验——非法 cron、EVENT 条件落 store、UPDATE 改 workunit
// status——仍在 store → 错误映射表保持 400 文案）；统一 envelope（原平铺
// `{ triggers, schedulerRunning }` / `{ days, ... }` / `{ fired, ... }` / 裸
// TriggerConfig / `{ ok }` / `{ logs }` / status 对象统一进 `{ data }` 壳）。
import { Router } from 'express';
import {
  triggerCostsQuerySchema,
  triggerIdParamsSchema,
  saveTriggerBodySchema,
  ERROR_CODES,
  type TriggerConfigWire,
} from '@dommaker/studio-contract';
import { TriggerStore } from './trigger-store.js';
import { getTriggerScheduler } from './trigger-registry.js';
import { executeCreateAction, executeExecuteAction } from './trigger-action.js';
import { parseStudioEventPayload } from '../../utils/studio-events.js';
// #342/#654：窗口读口（尾部倒读 + 窗口外早停；file 缺省即 resolveStudioEventsFile()）
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';
import { recordAgentDecision } from '../audit-logs/index.js';
import { randomUUID } from 'node:crypto';
import type { TriggerConfig } from './trigger.types.js';
import { defineRoute, HttpError } from '../../core/http.js';

const router = Router();
const store = new TriggerStore();
const scheduler = getTriggerScheduler(store); // Singleton — shared with AgentLoop

/** GET /api/triggers — list all triggers */
router.get('/', defineRoute({}, async () => {
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

  return { triggers: result, schedulerRunning: scheduler.isRunning() };
}));

/**
 * GET /api/triggers/costs?days=N — 按任务聚合 token 成本（手动触发按钮的成本展示）
 * workunit:tokens 按 payload.triggerId 求和（billedTokens 优先，旧事件退回 totalTokens）；
 * system:tokens 按事件 source 统计调用次数与 token（usage 缺失时 tokens 为 0，calls 仍准确）。
 * 注意：必须注册在 GET /:id 之前，否则被 :id 捕获。
 * #654：读口切 readStudioEventsSince（尾部倒扫、窗口外早停、NaT/损坏行跳过、文件不存在返回空），
 * 不再整文件 readFileSync 同步阻塞；聚合语义不变。
 */
router.get('/costs', defineRoute({ query: triggerCostsQuerySchema }, async (_req, _res, { query }) => {
  const days = Math.min(Math.max(parseInt(String(query.days ?? '30'), 10) || 30, 1), 365);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const byTrigger: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const callsBySource: Record<string, number> = {};
  const events = await readStudioEventsSince({ sinceMs: since });
  for (const e of events) {
    const payload = parseStudioEventPayload(e);
    if (!payload) continue;
    if (e.type === 'workunit:tokens' && typeof payload.triggerId === 'string') {
      const t = Number(payload.billedTokens ?? payload.totalTokens ?? 0) || 0;
      byTrigger[payload.triggerId] = (byTrigger[payload.triggerId] || 0) + t;
    } else if (e.type === 'system:tokens') {
      const src = (typeof e.source === 'string' && e.source) || 'system-executor';
      callsBySource[src] = (callsBySource[src] || 0) + 1;
      const t = (Number(payload.inputTokens) || 0) + (Number(payload.outputTokens) || 0);
      bySource[src] = (bySource[src] || 0) + t;
    }
  }
  return { days, byTrigger, bySource, callsBySource };
}));

/** GET /api/triggers/:id — get single trigger */
router.get('/:id', defineRoute({ params: triggerIdParamsSchema }, async (_req, _res, { params }) => {
  const trigger = store.get(params.id);
  if (!trigger) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Trigger not found');
  return trigger;
}));

/** POST /api/triggers — create or update trigger */
router.post('/', defineRoute(
  { body: saveTriggerBodySchema },
  {
    status: 201,
    // store validateTrigger 语义错误（非法 cron、EVENT 条件、UPDATE 改 status 等）保持 400（旧行为）
    errors: [{ match: /.*/, status: 400, code: ERROR_CODES.BAD_REQUEST }],
  },
  async (_req, _res, { body }) => {
    // z.infer 退化（strict:false 字段可选）→ 路由边界显式收回
    const config = body as TriggerConfigWire as TriggerConfig;
    store.save(config);
    scheduler.loadTriggers();
    return { ok: true, id: config.id };
  },
));

/**
 * POST /api/triggers/:id/fire — 手动触发（「配不上自动化、但值得一个按钮」的入口）
 * - 不检查 enabled：已停用任务手动跑是明确意图（响应带 wasDisabled 提示）
 * - CREATE 不传 dedupeWithinMinute：B3 同分钟去重只约束 SCHEDULE 自动路径，手动连点不去重
 * - config 双源查找：yaml store + scheduler 内存（系统默认触发器不落 store）
 */
router.post('/:id/fire', defineRoute({ params: triggerIdParamsSchema }, async (req, _res, { params }) => {
  const config = store.get(params.id) ?? scheduler.getStates().find(s => s.config.id === params.id)?.config;
  if (!config) {
    throw new HttpError(404, ERROR_CODES.NOT_FOUND, `Trigger not found: ${params.id}`);
  }
  const wasDisabled = config.enabled === false;
  // #591：手动 fire 同落决策埋点（details.manual 区分自动触发；actor=操作人 human；
  // 失败也落 failure 行后原样上抛，与自动路径口径一致）
  const traceId = randomUUID();
  const actor = { id: (req as { user?: { id?: string } }).user?.id ?? 'unknown', type: 'human' as const };
  const recordFire = (outcome: Record<string, unknown>, status: 'success' | 'failure' = 'success') =>
    recordAgentDecision({
      action: config.action.type.toLowerCase(),
      resource: 'trigger',
      resourceId: config.id,
      actor,
      status,
      details: { triggerName: config.name, manual: true, ...outcome },
      requestId: traceId,
    });
  if (config.action.type === 'CREATE') {
    try {
      const workUnit = await executeCreateAction(config.action, config.id, { traceId });
      recordFire({ outcome: 'created', workUnitId: workUnit?.id });
      return { fired: true, wasDisabled, workUnit };
    } catch (err) {
      recordFire({ outcome: 'error', error: (err as Error).message }, 'failure');
      throw err;
    }
  }
  if (config.action.type === 'EXECUTE') {
    try {
      await executeExecuteAction(config.action, { manual: true });
      recordFire({ outcome: 'executed', target: config.action.target });
      return { fired: true, wasDisabled };
    } catch (err) {
      recordFire({ outcome: 'error', error: (err as Error).message }, 'failure');
      throw err;
    }
  }
  throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `Unsupported action type: ${config.action.type}`);
}));

/** DELETE /api/triggers/:id — delete trigger */
router.delete('/:id', defineRoute({ params: triggerIdParamsSchema }, async (_req, _res, { params }) => {
  const deleted = store.delete(params.id);
  if (!deleted) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'Trigger not found');
  scheduler.loadTriggers();
  return { ok: true };
}));

/** GET /api/triggers/:id/logs — get scheduler logs for a trigger */
router.get('/:id/logs', defineRoute({ params: triggerIdParamsSchema }, async (_req, _res, { params }) => {
  const logs = scheduler.getLogs().filter(l => l.triggerId === params.id);
  return { logs };
}));

/** GET /api/triggers/status — scheduler status */
router.get('/status', defineRoute({}, async () => {
  return {
    running: scheduler.isRunning(),
    triggerCount: scheduler.getStates().length,
    logCount: scheduler.getLogs().length,
  };
}));

export { router as triggerRouter, scheduler };
