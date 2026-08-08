/**
 * WU → PMO 创建期归因戳（2026-08 归因统一）：canonical metadata key = `pmoId`。
 *
 * 写入方（WU 创建时一次性落档，此后不再变化）：
 *   - channels/message-routing.ts（@mention 派发，ownership 解析出 PMO 项目时）
 *   - pmo/project.service.ts / pmo/analysis-handoff.ts（PMO 派生链 task WU，连同 pmoNumber）
 *
 * `ownershipProjectId` 是 2026-08 前 message-routing 写入的 deprecated legacy 同位名，
 * 读取侧与 pmoId 同级兼容（pmoId 优先）；生产存量为零，仅为滚动升级读兼容保留。
 *
 * 本模块是零 app 依赖的叶子：pmo/evidence-summary.ts 需要同步内存解析同一口径，
 * 但它不能传递依赖 pmo-branch-resolver（→ pmo/project.service → workunit.service
 * 会成循环），故纯解析收敛于此，两个消费方各自 import。
 */

/**
 * metadata.pmoId（canonical）→ metadata.ownershipProjectId（legacy 同位）容错解析。
 * 纯同步、纯内存；坏 JSON / 非字符串 / 空串 → null。
 */
export function parseWuPmoId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { pmoId?: unknown; ownershipProjectId?: unknown };
    if (typeof meta.pmoId === 'string' && meta.pmoId) return meta.pmoId;
    return typeof meta.ownershipProjectId === 'string' && meta.ownershipProjectId
      ? meta.ownershipProjectId
      : null;
  } catch {
    return null;
  }
}
