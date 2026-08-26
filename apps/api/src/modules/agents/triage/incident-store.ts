/**
 * incident-store（#255）— incidents.jsonl append-only 存储语义
 *
 * 背景：triage.service 的 updateIncident 原为 readJsonl → 整文件 writeFile 覆写，
 * 与 #213 日志轮转（rename 热文件 → 处理 → 幸存者 append 回写）交错时会复活已归档
 * 行并覆盖轮转刚回写的幸存行。rename 防丢行承诺只对 append-only 写入方成立。
 *
 * 语义：更新 = 追加同 id 新行（带 updatedAt），读方按 rank 归并（updatedAt，缺省
 * createdAt；并列时后行胜出）。轮转回写的旧行 rank 低于窗口后写入的新行，
 * 文件行序被打乱也不影响归并结果；窗口内整文件永不覆写 → 无行复活/丢失。
 */
import type { FileStore } from '@dommaker/studio-shared';

export interface IncidentRow {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

function parseIso(v: unknown): number {
  if (typeof v !== 'string' || !v) return NaN;
  return Date.parse(v);
}

/** 行新旧排序值：updatedAt 优先，缺省 createdAt；皆无 → -Infinity（并列时靠行序决胜） */
function rowRank(row: IncidentRow): number {
  const u = parseIso(row.updatedAt);
  if (Number.isFinite(u)) return u;
  const c = parseIso(row.createdAt);
  if (Number.isFinite(c)) return c;
  return Number.NEGATIVE_INFINITY;
}

/**
 * 按 id 归并（last-wins by rank）：rank 大者胜，并列时后出现的行胜出。
 * 无 id 的行跳过。返回 id → 最新行的映射。
 *
 * #360 注记：不接线共享 foldJsonlById——本处是 rank 口径（updatedAt 决胜，
 * 防 #255 轮转行复活），foldJsonlById 是行序口径，塞入会丢防复活保证。
 */
export function foldIncidentRows<T extends IncidentRow>(rows: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  const rankById = new Map<string, number>();
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== 'string' || id === '') continue;
    const rank = rowRank(row);
    const prevRank = rankById.get(id);
    if (prevRank === undefined || rank >= prevRank) {
      byId.set(id, row);
      rankById.set(id, rank);
    }
  }
  return byId;
}

/**
 * append-only 更新：读热文件归并出当前行，合并 patch 后以新行追加（带 updatedAt）。
 * 目标不存在（含轮转窗口内热文件暂空）→ no-op 返回 false：行不丢不复活，
 * 该次更新本身丢弃（与旧实现同窗口行为一致，窗口后重试可恢复）。
 * 并发前提：读-归并-append 无锁，同 id 并发更新 last-writer-wins；
 * 现网唯一调用方 handleAlert 流程内串行 await，满足该前提。
 */
export async function appendIncidentUpdate(
  fileStore: FileStore,
  filePath: string,
  incidentId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const rows = await fileStore.readJsonl<IncidentRow>(filePath);
  const current = foldIncidentRows(rows).get(incidentId);
  if (!current) return false;
  await fileStore.appendJsonl(filePath, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  return true;
}
