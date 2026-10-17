// Trigger Routes — REST API for triggers（3.28c-4）
//
// Phase 4 批5（2026-10-17）：管理面 6 条孤儿端点删除（GET /、GET /status、GET /:id、
// POST /、DELETE /:id、GET /:id/logs——零消费方），只保留两个活面：
//   GET  /costs      成本聚合（前端 api/maintenance.ts getCosts）
//   POST /:id/fire   手动触发（前端 api/maintenance.ts fireTrigger；ProjectDetailPage/
//                    LibraryPage 手动任务按钮）
// 管理面的 store/scheduler 操作不经 HTTP：default-triggers 代码注册、store YAML 用户可改。
//
// 契约驱动迁移（2026-10 批次 3/7）：全部端点走 core/http.ts defineRoute——
// 统一 envelope（`{ days, ... }` / `{ fired, ... }` 统一进 `{ data }` 壳）。
import { Router } from 'express';
import {
  triggerCostsQuerySchema,
  triggerIdParamsSchema,
  ERROR_CODES,
} from '@dommaker/studio-contract';
import { TriggerStore } from './trigger-store.js';
import { getTriggerScheduler } from './trigger-registry.js';
import { executeCreateAction, executeExecuteAction } from './trigger-action.js';
import { parseStudioEventPayload } from '@dommaker/studio-shared';
// #342/#654：窗口读口（尾部倒读 + 窗口外早停；file 缺省即 resolveStudioEventsFile()）
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';
import { recordAgentDecision } from '../audit-logs/index.js';
import { randomUUID } from 'node:crypto';
import { defineRoute, HttpError } from '../../core/http.js';

const router = Router();
const store = new TriggerStore();
const scheduler = getTriggerScheduler(store); // Singleton — shared with AgentLoop

/**
 * GET /api/triggers/costs?days=N — 按任务聚合 token 成本（手动触发按钮的成本展示）
 * workunit:tokens 按 payload.triggerId 求和（billedTokens 优先，旧事件退回 totalTokens）；
 * system:tokens 按事件 source 统计调用次数与 token（usage 缺失时 tokens 为 0，calls 仍准确）。
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

export { router as triggerRouter, scheduler };
