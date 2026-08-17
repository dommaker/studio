/**
 * #163（T8-E2，#130 决策 2/6）：巡检机会清单的采纳/忽略——机制消费入口。
 *
 * - adopt：采纳即人工闸（T4 单层人闸）→ 建 feature WU **显式 status='unassigned'**
 *   直接进 frontier 可认领（不落 pending 再确认 = 双重人闸，违背 T4）；源单条目记 wuId。
 *   子单不带 channelId（避免触发频道默认管线展开），继承 pmoId/workspaceRoot 归属链
 *   （同 analysis-handoff 派生先例），metadata 落溯源戳。
 * - ignore：终态，可附理由（下轮巡检不重复上报的判据）。
 *
 * metadata 更新 = read-modify-write（PUT 整体替换语义下唯一安全路径），写入前重读
 * 合并（#115 实测两哨兵互覆教训）。
 */
import type { WorkUnitData } from './workunit.service.js';
import { WorkUnitService, type InspectionOpportunity } from './workunit.service.js';
import { parseWuMetadata } from './wu-metadata.js';

async function resolvePendingOpportunity(
  service: WorkUnitService,
  wuId: string,
  oppId: string,
): Promise<{ wu: WorkUnitData; opportunities: InspectionOpportunity[]; index: number }> {
  const wu = await service.getById(wuId);
  if (!wu) throw new Error(`WorkUnit ${wuId} not found`);
  const meta = parseWuMetadata(wu.metadata);
  if (meta.inspection !== true) {
    throw new Error(`WorkUnit ${wuId} is not an inspection workunit`);
  }
  const opportunities = Array.isArray(meta.opportunities) ? meta.opportunities : [];
  const index = opportunities.findIndex(o => o && o.id === oppId);
  if (index < 0) throw new Error(`Opportunity ${oppId} not found in WorkUnit ${wuId}`);
  if (opportunities[index].status !== 'pending') {
    throw new Error(`Opportunity ${oppId} already resolved (${opportunities[index].status})`);
  }
  return { wu, opportunities, index };
}

/** 写回更新后的 opportunities（重读合并防丢并发更新） */
async function writeBackOpportunities(
  service: WorkUnitService,
  wuId: string,
  oppId: string,
  patch: Partial<InspectionOpportunity>,
): Promise<InspectionOpportunity[]> {
  const fresh = await service.getById(wuId);
  if (!fresh) throw new Error(`WorkUnit ${wuId} not found`);
  const meta = parseWuMetadata(fresh.metadata);
  const opportunities = (Array.isArray(meta.opportunities) ? meta.opportunities : []).map(o =>
    o.id === oppId ? { ...o, ...patch } : o,
  );
  await service.update(wuId, { metadata: { ...meta, opportunities } });
  return opportunities;
}

/** 采纳：建 feature 子单（显式 unassigned 进 frontier）+ 源条目记 wuId */
export async function adoptInspectionOpportunity(
  service: WorkUnitService,
  wuId: string,
  oppId: string,
): Promise<{ workUnit: WorkUnitData; opportunities: InspectionOpportunity[] }> {
  const { wu, opportunities, index } = await resolvePendingOpportunity(service, wuId, oppId);
  const opp = opportunities[index];
  const sourceMeta = parseWuMetadata(wu.metadata);

  const scope = `${opp.problem}\n\n建议：${opp.suggestion}${opp.estimate ? `\n预估：${opp.estimate}` : ''}`;
  const workUnit = await service.create({
    type: 'feature',
    scope,
    status: 'unassigned', // 采纳动作即人工闸（T4 单层人闸），显式跳过 PENDING_CONFIRM_TYPES 默认
    parentId: wuId,
    metadata: {
      creationMode: 'inspection-adopt',
      sourceInspectionWuId: wuId,
      sourceOpportunityId: oppId,
      // 归属链继承（同 analysis-handoff 先例）：执行落正确工程/PMO 归因
      ...(typeof sourceMeta.pmoId === 'string' && sourceMeta.pmoId ? { pmoId: sourceMeta.pmoId } : {}),
      ...(typeof sourceMeta.workspaceRoot === 'string' && sourceMeta.workspaceRoot
        ? { workspaceRoot: sourceMeta.workspaceRoot }
        : {}),
    },
  });

  const updated = await writeBackOpportunities(service, wuId, oppId, {
    status: 'adopted',
    wuId: workUnit.id,
  });
  return { workUnit, opportunities: updated };
}

/** 忽略：终态，可附理由 */
export async function ignoreInspectionOpportunity(
  service: WorkUnitService,
  wuId: string,
  oppId: string,
  reason?: string,
): Promise<{ opportunities: InspectionOpportunity[] }> {
  await resolvePendingOpportunity(service, wuId, oppId);
  const updated = await writeBackOpportunities(service, wuId, oppId, {
    status: 'ignored',
    ...(typeof reason === 'string' && reason.trim() ? { ignoreReason: reason.trim() } : {}),
  });
  return { opportunities: updated };
}
