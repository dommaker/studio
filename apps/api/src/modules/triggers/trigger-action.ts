// Trigger Action — execute trigger actions (3.28c-4, AS-026 extended)
// Supports: CREATE WorkUnit, EXECUTE handler, UPDATE entity
import { FileStore, logger, type WorkUnitEvent, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { TriggerAction, TriggerExecuteHandler } from './trigger.types.js';
import { WorkUnitService } from '../workunit/workunit.service.js';

/** Handler registry for EXECUTE actions */
const executeHandlers = new Map<string, TriggerExecuteHandler>();

// ── UPDATE query 匹配（P0 修复：操作符比较 + 基准时间推迟到执行时刻）──

type CompareOp = 'lt' | 'gt' | 'lte' | 'gte';
const COMPARE_OPS: CompareOp[] = ['lt', 'gt', 'lte', 'gte'];

/** '$now' 占位符：在每次执行（tick）时求值为当前 ISO 时间，而不是注册时冻结 */
export const NOW_PLACEHOLDER = '$now';

/**
 * 单字段匹配：期望值是含 lt/gt/lte/gte 键的对象 → 操作符比较（全部满足）；
 * 否则浅层全等（与原行为一致）。操作符比较：任一侧为数值 → 数值比较；
 * 其余按字符串比较（ISO 8601 同格式字典序即时序，适用于 timeoutAt 等时间字段）。
 */
export function matchesQueryValue(actual: unknown, expected: unknown, nowIso: string): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const ops = expected as Record<string, unknown>;
    const opKeys = COMPARE_OPS.filter(op => op in ops);
    if (opKeys.length > 0) {
      return opKeys.every(op => compareValues(actual, resolveNow(ops[op], nowIso), op));
    }
  }
  return actual === resolveNow(expected, nowIso);
}

function resolveNow(value: unknown, nowIso: string): unknown {
  return value === NOW_PLACEHOLDER ? nowIso : value;
}

function compareValues(actual: unknown, expected: unknown, op: CompareOp): boolean {
  if (actual === null || actual === undefined) return false;
  let a: number | string;
  let b: number | string;
  if (typeof actual === 'number' || typeof expected === 'number') {
    a = Number(actual);
    b = Number(expected);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
  } else {
    a = String(actual);
    b = String(expected);
  }
  switch (op) {
    case 'lt': return a < b;
    case 'gt': return a > b;
    case 'lte': return a <= b;
    case 'gte': return a >= b;
  }
}

/** Register a handler for EXECUTE actions */
export function registerExecuteHandler(target: string, handler: TriggerExecuteHandler): void {
  executeHandlers.set(target, handler);
}

/** Unregister a handler */
export function unregisterExecuteHandler(target: string): void {
  executeHandlers.delete(target);
}

let fileStore = new FileStore();
let workUnitService = new WorkUnitService();

/** 测试用：替换 FileStore/WorkUnitService 实例（同 channelMessageService.setFileStore 模式） */
export function setTriggerActionFileStore(fs: FileStore): void {
  fileStore = fs;
  workUnitService = new WorkUnitService(fs);
}

/**
 * B3 触发器幂等（2026-08-03 token-burn issue）：同一 triggerId 在同一分钟内已创建过 WU 则跳过。
 * 跨进程/重启兜底（in-memory lastFiredAt 挡不住）：两个实例共享数据根时第二个进程在此被拦。
 * 判定依据是 executeCreateAction 自己写入的 metadata.triggerId + triggeredAt。
 */
async function findTriggerWorkUnitInMinute(triggerId: string, now: Date): Promise<boolean> {
  const minuteStart = new Date(now).setSeconds(0, 0);
  const snapshots = await fileStore.getIndex();
  for (const s of snapshots) {
    // 快速预筛：metadata 串不含该 triggerId 直接跳过（避免全量 JSON.parse）
    if (!s.metadata || !s.metadata.includes(`"triggerId":"${triggerId}"`)) continue;
    try {
      const meta = JSON.parse(s.metadata) as { triggerId?: unknown; triggeredAt?: unknown };
      if (meta.triggerId !== triggerId || typeof meta.triggeredAt !== 'string') continue;
      const t = new Date(meta.triggeredAt).getTime();
      if (Number.isFinite(t) && t >= minuteStart && t <= now.getTime()) return true;
    } catch { /* metadata 损坏跳过 */ }
  }
  return false;
}

/**
 * Execute a CREATE action — creates a WorkUnit from trigger payload.
 * @param action - The trigger action definition
 * @param triggerId - The trigger ID (stored in WorkUnit metadata for traceability)
 * @param opts.dedupeWithinMinute - B3 幂等：提供时按「同 triggerId 同分钟」去重（SCHEDULE 触发专用），命中返回 null
 * @returns The created WorkUnit; 去重命中时返回 null
 */
export async function executeCreateAction(
  action: TriggerAction,
  triggerId: string,
): Promise<{ id: string; type: string; scope: string; status: string; channelId: string | null; metadata: string | null }>;
export async function executeCreateAction(
  action: TriggerAction,
  triggerId: string,
  opts: { dedupeWithinMinute?: Date },
): Promise<{ id: string; type: string; scope: string; status: string; channelId: string | null; metadata: string | null } | null>;
export async function executeCreateAction(
  action: TriggerAction,
  triggerId: string,
  opts?: { dedupeWithinMinute?: Date },
): Promise<{ id: string; type: string; scope: string; status: string; channelId: string | null; metadata: string | null } | null> {
  if (action.type !== 'CREATE') {
    throw new Error(`Unknown action type: ${action.type}`);
  }

  if (opts?.dedupeWithinMinute) {
    if (await findTriggerWorkUnitInMinute(triggerId, opts.dedupeWithinMinute)) {
      logger.info(`[TriggerAction] CREATE deduped: trigger "${triggerId}" already created a WorkUnit this minute`);
      return null;
    }
  }

  const { type, scope, channelId, metadata, assigneeRole } = action.payload;

  // 系统维护类任务点名角色（如 'studio'）：解析为 profile id 写入 assigneeId，
  // 认领语义为独占（仅该 profile 的 loop 可见），消除「谁抢到谁执行」的不确定性。
  // 角色不存在时回退 unassigned（频道竞争认领的老行为），不阻塞创建。
  let assigneeId: string | undefined;
  if (assigneeRole) {
    const profiles = await fileStore.listProfiles();
    const role = profiles.find(p => p.name === assigneeRole);
    if (role) {
      assigneeId = role.id;
    } else {
      logger.warn(`[TriggerAction] assigneeRole "${assigneeRole}" not found, falling back to unassigned`, { triggerId });
    }
  }

  const mergedMetadata = {
    ...(metadata || {}),
    triggerId,
    triggerSource: 'trigger-registry',
    triggeredAt: new Date().toISOString(),
  };

  const workUnit = await workUnitService.create({
    type,
    scope,
    channelId: channelId || null,
    assigneeId,
    metadata: mergedMetadata,
  });

  return {
    id: workUnit.id,
    type: workUnit.type,
    scope: workUnit.scope,
    status: workUnit.status,
    channelId: workUnit.channelId,
    metadata: workUnit.metadata,
  };
}

/**
 * Execute an EXECUTE action — calls a registered handler.
 * @param action - The trigger action definition (must be EXECUTE type)
 * @param context - Context passed to the handler (e.g. event payload)
 */
export async function executeExecuteAction(
  action: TriggerAction,
  context: unknown,
): Promise<void> {
  if (action.type !== 'EXECUTE') {
    throw new Error(`Expected EXECUTE action, got: ${action.type}`);
  }

  const handler = executeHandlers.get(action.target);
  if (!handler) {
    logger.warn(`[TriggerAction] No handler registered for execute target: ${action.target}`);
    return;
  }

  await handler(context);
}

/**
 * Execute an UPDATE action — updates entity via FileStore.
 * @param action - The trigger action definition (must be UPDATE type)
 */
export async function executeUpdateAction(
  action: TriggerAction,
  _context: unknown,
): Promise<void> {
  if (action.type !== 'UPDATE') {
    throw new Error(`Expected UPDATE action, got: ${action.type}`);
  }

  const query = action.config.query;
  const update = action.config.update;

  // Only support workunit entity for MVP
  if (action.target === 'workunit') {
    const snapshots = await fileStore.getIndex();
    const now = new Date().toISOString();

    for (const s of snapshots) {
      // Match snapshot against query（浅层全等 + { lt, gt, lte, gte } 操作符；
      // '$now' 占位符在执行时刻求值 —— 基准时间不冻结在注册时）
      let matches = true;
      for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
        if (!matchesQueryValue((s as unknown as Record<string, unknown>)[key], value, now)) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      const updatedSnapshot: WorkUnitSnapshot = {
        ...s,
        ...update as Partial<WorkUnitSnapshot>,
        updatedAt: now,
      };
      const event: WorkUnitEvent = {
        type: 'updated',
        wuId: s.id,
        timestamp: now,
        data: updatedSnapshot as unknown as Record<string, unknown>,
      };
      await fileStore.commitSnapshot(event, updatedSnapshot);
    }
  } else {
    logger.warn(`[TriggerAction] Unknown UPDATE target: ${action.target}`);
  }
}
