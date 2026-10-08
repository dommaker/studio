/**
 * WU → PMO 创建期归因戳（2026-08 归因统一）：canonical metadata key = `pmoId`。
 *
 * 写入方（WU 创建时一次性落档，此后不再变化）：
 *   - channels/message-routing.ts（@mention 派发，ownership 解析出 PMO 项目时）
 *   - pmo/project.service.ts / pmo/analysis-handoff.ts（PMO 派生链 task WU，连同 pmoNumber）
 *
 * 2026-08 前的 legacy 同位名 `ownershipProjectId` 读兼容已随架构精简刀6 删除
 * （生产存量实测为零）。
 *
 * 本模块是零 app 依赖的叶子：pmo/evidence-summary.ts 需要同步内存解析同一口径，
 * 但它不能传递依赖 pmo-branch-resolver（→ pmo/project.service → workunit.service
 * 会成循环），故纯解析收敛于此，两个消费方各自 import。
 */

/**
 * metadata.pmoId 解析。纯同步、纯内存；坏 JSON / 非字符串 / 空串 → null。
 */
export function parseWuPmoId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { pmoId?: unknown };
    return typeof meta.pmoId === 'string' && meta.pmoId ? meta.pmoId : null;
  } catch {
    return null;
  }
}
