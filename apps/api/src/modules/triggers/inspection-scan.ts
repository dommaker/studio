/**
 * #163（T8-E2，#130 决策 4/5）：inspection-scan 触发器的事件闸——bug 关闭累计计数 + 冷却去重。
 *
 * 判定链（EVENT 路径，trigger-scheduler.handleEvent 对 inspection-scan 分叉调用）：
 *   1. 事件形状：payload.workunit.type==='bug' 且 status==='closed'，否则忽略
 *      （trigger 的 matchFilter 是顶层浅匹配，吃不了 { workunit: {...} } 嵌套形态，故闸内自判）；
 *   2. 阈值：最近一张巡检单创建之后关闭的 bug 数 >= N（INSPECTION_SCAN_THRESHOLD 覆盖，
 *      默认 3，<=0 = 关闭事件触发；无历史巡检单 = 对照全部 closed bug）——
 *      无独立计数器状态，从 FileStore 现算，巡检单一建即自然归零；
 *   3. 冷却：最近一张巡检单（metadata.inspection===true）的 opportunities 存在 pending
 *      条目 → 跳过，调用方落 studio-events 事件留痕，频道不打扰；无历史单放行。
 *
 * 手动 fire（POST /api/triggers/inspection-scan/fire）直调 executeCreateAction，
 * 不经过本闸（T9/#131 决策 2：人点按钮是显式意图；pending 人闸照过）。
 * SCHEDULE 留位（inspection-scan-schedule，默认关闭）启用后由 tick 路径过 checkInspectionCooldown。
 */
import type { FileStore, WorkUnitSnapshot } from '@dommaker/studio-shared';
import { getTriggerActionFileStore } from './trigger-action.js';

export const INSPECTION_SCAN_TRIGGER_ID = 'inspection-scan';
export const INSPECTION_SCAN_SCHEDULE_TRIGGER_ID = 'inspection-scan-schedule';
export const DEFAULT_INSPECTION_SCAN_THRESHOLD = 3;

/** bug 关闭累计阈值：INSPECTION_SCAN_THRESHOLD 覆盖；非法值回落默认；<=0 = 关闭事件触发 */
export function resolveInspectionScanThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INSPECTION_SCAN_THRESHOLD?.trim();
  if (!raw) return DEFAULT_INSPECTION_SCAN_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INSPECTION_SCAN_THRESHOLD;
  return Math.floor(n);
}

export type InspectionEventVerdict =
  | { fire: true }
  | { fire: false; reason: 'not-bug-closed' | 'disabled' | 'below-threshold' }
  | { fire: false; reason: 'cooldown'; pendingCount: number; latestWuId: string };

interface LatestInspection {
  id: string;
  createdAt: string;
  pendingCount: number;
}

/** 找最近一张巡检单（metadata.inspection===true）及其 pending 机会条数；无历史单 → null */
async function findLatestInspection(fs: FileStore): Promise<LatestInspection | null> {
  const snapshots = await fs.getIndex();
  let latest: WorkUnitSnapshot | null = null;
  let latestPending = 0;
  for (const s of snapshots) {
    // 快速预筛（同 findTriggerWorkUnitInMinute 模式）：metadata 串不含标记直接跳过
    if (!s.metadata || !s.metadata.includes('"inspection":true')) continue;
    let meta: { inspection?: unknown; opportunities?: unknown };
    try {
      meta = JSON.parse(s.metadata);
    } catch { continue; /* metadata 损坏跳过 */ }
    if (meta.inspection !== true) continue;
    if (latest && s.createdAt <= latest.createdAt) continue;
    latest = s;
    const opps = Array.isArray(meta.opportunities) ? meta.opportunities : [];
    latestPending = opps.filter(
      (o): o is { status?: unknown } => o !== null && typeof o === 'object',
    ).filter(o => o.status === 'pending').length;
  }
  return latest ? { id: latest.id, createdAt: latest.createdAt, pendingCount: latestPending } : null;
}

/** 冷却闸（EVENT 第 3 步 / SCHEDULE tick 共用）：最近巡检单有待处理机会条目 → skip */
export async function checkInspectionCooldown(
  fs: FileStore = getTriggerActionFileStore(),
): Promise<{ skip: boolean; pendingCount: number; latestWuId?: string }> {
  const latest = await findLatestInspection(fs);
  if (!latest) return { skip: false, pendingCount: 0 }; // 无历史单放行
  if (latest.pendingCount > 0) {
    return { skip: true, pendingCount: latest.pendingCount, latestWuId: latest.id };
  }
  return { skip: false, pendingCount: 0, latestWuId: latest.id };
}

/** EVENT 闸完整判定链（bug 关闭计数 → 冷却） */
export async function evaluateInspectionEvent(
  payload: unknown,
  fs: FileStore = getTriggerActionFileStore(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<InspectionEventVerdict> {
  const wu = (payload as { workunit?: { type?: unknown; status?: unknown } } | null)?.workunit;
  if (!wu || wu.type !== 'bug' || wu.status !== 'closed') {
    return { fire: false, reason: 'not-bug-closed' };
  }

  const threshold = resolveInspectionScanThreshold(env);
  if (threshold <= 0) return { fire: false, reason: 'disabled' };

  const latest = await findLatestInspection(fs);

  // 计数：最近巡检单创建之后关闭的 bug 数（无历史单 = 全部 closed bug）
  const snapshots = await fs.getIndex();
  let closedBugs = 0;
  for (const s of snapshots) {
    if (s.type !== 'bug' || s.status !== 'closed') continue;
    if (latest && s.updatedAt <= latest.createdAt) continue;
    closedBugs++;
  }
  if (closedBugs < threshold) return { fire: false, reason: 'below-threshold' };

  // 冷却：最近巡检单有待处理条目 → 跳过（含待处理条数，调用方落事件留痕）
  if (latest && latest.pendingCount > 0) {
    return { fire: false, reason: 'cooldown', pendingCount: latest.pendingCount, latestWuId: latest.id };
  }
  return { fire: true };
}
