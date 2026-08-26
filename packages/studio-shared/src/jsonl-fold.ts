/**
 * JSONL append-only 行折叠（#360）
 *
 * 决策（2026-08-25 grilling，issue #360）：共享折叠函数只干「按 id 分组、每组取
 * 最新一行」；哪行算作废（墓碑）由各业务传入判断函数。不统一各业务的作废写法，
 * 不动存储格式与历史语义——墓碑收尾是否丢弃整组、墓碑行取首个还是末个，
 * 全部留在业务侧 adapter 自决：
 *
 *   - channels（#319 口径）：墓碑行收尾 = voided，整条丢弃（mergeActiveRows）
 *   - notification：墓碑 = 已读标记，不丢弃；data 作数据载体，首个墓碑作 readAt
 *   - review-proposal / role-memory：kind:'status' 行 = 状态墓碑，不丢弃；
 *     data 作条目载体，末个墓碑作最新状态
 *
 * 口径不适配者不接线（防塞错 seam）：triage incidents 用 rank 归并（updatedAt
 * 决胜，防轮转行复活），workunit 事件流用归约 merge，均非「最新一行」语义。
 */

/** 一个 id 分组的折叠结果 */
export interface JsonlFoldGroup<T> {
  /** 组内最后一行（可能是作废行本身） */
  latest: T;
  /** 组内最后一行是否作废行（墓碑收尾 = channels #319 口径的整组死亡信号） */
  voided: boolean;
  /** 组内最后一条非作废行（数据载体）；组内全为作废行时为 null */
  data: T | null;
  /** 组内全部作废行（文件序）：首个供 readAt 类口径，末个供最新状态类口径 */
  tombstones: readonly T[];
}

/**
 * 按 id 分组折叠 append-only JSONL 行：每组取最新一行（Map 插入序 = id 首现
 * 位置序，与 channels mergeActiveRows 现口径一致）。纯函数，读行仍走
 * FileStore.readJsonl；不读写文件、不做丢弃决策。
 */
export function foldJsonlById<T extends { id: string }>(
  rows: readonly T[],
  isTombstone: (row: T) => boolean,
): Map<string, JsonlFoldGroup<T>> {
  const groups = new Map<string, { latest: T; data: T | null; tombstones: T[] }>();
  for (const row of rows) {
    let group = groups.get(row.id);
    if (!group) {
      group = { latest: row, data: null, tombstones: [] };
      groups.set(row.id, group);
    }
    group.latest = row;
    if (isTombstone(row)) group.tombstones.push(row);
    else group.data = row;
  }

  const folded = new Map<string, JsonlFoldGroup<T>>();
  for (const [id, group] of groups) {
    folded.set(id, {
      latest: group.latest,
      voided: isTombstone(group.latest),
      data: group.data,
      tombstones: group.tombstones,
    });
  }
  return folded;
}
