/**
 * #285 AC4（决策 #249 §5）：per-WU 产出/修改文件集的最小查询面 ——
 * agent 消息文件 chip 的第一优先词表（拿不到 → 调用方降级候选集词表）。
 *
 * 数据链：session:start 事件 payload.workUnitId（#174 起由 runner 落）
 * → sessionId 集合 → file:change 事件（studio-agent output-capture 对
 * Write/Edit 工具调用发射，payload.path = 工具入参 file_path）。
 *
 * 数据形态注意：
 * - 路径通常是 per-execution worktree 内的绝对路径，非候选仓路径；
 *   chip 侧按绝对路径直接匹配，不强行映射回候选仓。
 * - file:change 事件无 envelope level（按信号类保留：热 30 天 → 月度归档），
 *   归档/清理后自然查不到 → 返回空数组，chip 降级候选集词表，行为不变。
 *
 * 读取失败/无数据 → 空数组，绝不抛出（#249/#251：派生绝不抛出）。
 */
import { logger } from '@dommaker/studio-shared';
import { parseStudioEventPayload } from '../../utils/studio-events.js';
// #335：窗口读口（尾部倒读 + 窗口外早停），替代 readStudioEvents 全量读
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';

/** #335：本模块语义即"只查近期事件"（归档后自然查不到 → chip 降级）；窗口对齐 #173 热文件保留期 */
const EVENTS_WINDOW_MS = 30 * 24 * 3600_000;

export interface WuChangedFilesDeps {
  /** 事件来源（默认 = 窗口读口 readStudioEventsSince，窗口 = EVENTS_WINDOW_MS 30d）；测试注入 */
  readEvents?: () => Promise<Array<Record<string, unknown>>>;
}

/** WU 全部 session 的产出/修改文件绝对路径（去重，按事件序） */
export async function listWorkUnitChangedFiles(
  workUnitId: string,
  deps: WuChangedFilesDeps = {},
): Promise<string[]> {
  const map = await listWorkUnitsChangedFiles([workUnitId], deps);
  return map[workUnitId] ?? [];
}

/** 事件集 → 各 WU 文件集（session:start.workUnitId → sessionId → file:change.path，去重保序） */
function collectChangedFiles(
  events: Array<Record<string, unknown>>,
  ids: string[],
): Record<string, string[]> {
  const wanted = new Set(ids);
  const result: Record<string, string[]> = {};
  for (const id of ids) result[id] = [];
  const sessionWu = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'session:start') continue;
    const p = parseStudioEventPayload<{ workUnitId?: unknown; sessionId?: unknown }>(e);
    if (p && typeof p.workUnitId === 'string' && wanted.has(p.workUnitId)
      && typeof p.sessionId === 'string' && p.sessionId) {
      sessionWu.set(p.sessionId, p.workUnitId);
    }
  }
  if (sessionWu.size === 0) return result;
  const seenByWu = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== 'file:change') continue;
    const p = parseStudioEventPayload<{ sessionId?: unknown; path?: unknown }>(e);
    if (!p || typeof p.sessionId !== 'string') continue;
    const wuId = sessionWu.get(p.sessionId);
    if (!wuId || typeof p.path !== 'string' || !p.path) continue;
    let seen = seenByWu.get(wuId);
    if (!seen) { seen = new Set<string>(); seenByWu.set(wuId, seen); }
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    result[wuId].push(p.path);
  }
  return result;
}

/**
 * 批量版（2026-09-25 频道首屏合并）：一次窗口读派生全部 WU 的文件集，
 * 替代逐 WU 单发各自全窗口读（N 个 WU = N 次 30d 窗口扫描）。
 * 读取失败 → 全部空集降级，绝不抛出（与单发同口径）。
 */
export async function listWorkUnitsChangedFiles(
  workUnitIds: string[],
  deps: WuChangedFilesDeps = {},
): Promise<Record<string, string[]>> {
  const ids = [...new Set(workUnitIds.filter(id => typeof id === 'string' && id))];
  try {
    const events = await (deps.readEvents ?? (() => readStudioEventsSince({ sinceMs: Date.now() - EVENTS_WINDOW_MS })))();
    return collectChangedFiles(events, ids);
  } catch (err) {
    // 派生绝不抛出（#249/#251）：事件文件读取失败 → 空集，chip 降级候选集词表
    logger.warn('[WuChangedFiles] Batch read failed, degraded to empty sets', {
      count: ids.length, error: String(err),
    });
    return Object.fromEntries(ids.map(id => [id, [] as string[]]));
  }
}
