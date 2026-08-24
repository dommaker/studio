/**
 * 当前 WU 聚合上下文（2026-07 PMO-flow UX §6-1；#318 自 monitoring.service 提取为共享出口）：
 * getAgentSummary 与 agent.instance.status_changed 负载（agent-loop publishInstanceStatus）共用——
 * 防两处拷贝契约漂移（同 parseWuTitle 的「唯一对齐出口」原则）。
 *
 * WU 快照 / requirement / project 各读一次（FileStore JSON），内存 map 匹配——不逐 WU 串行读文件。
 * WU 不存在于 index（悬空 currentWorkUnitId）→ 无 map 项（调用方得 null）。
 * projects 由调用方注入（测试 stub 避免碰真实 ~/.studio/projects；生产 = projectService.list 大页）。
 */

import type { FileStore } from '@dommaker/studio-shared';
import type { RequirementWithProject } from '../requirements/requirement.service.js';
import { resolvePmoProjectIdForWU } from '../requirements/pmo-branch-resolver.js';
import type { ProjectData } from '../pmo/project.service.js';
import { parseWuTitle } from '../workunit/wu-metadata.js';

/** 2026-07 PMO-flow UX（§6-1）：/monitoring/agents 聚合的当前 WU 快照 */
export interface AgentCurrentWorkUnit {
  id: string;
  /** metadata.title ?? scope（原样，不截断） */
  title: string;
  type: string;
  status: string;
  claimedAt: string | null;
}

/** 2026-07 PMO-flow UX（§6-1）：/monitoring/agents 聚合的归属 PMO 摘要 */
export interface AgentPmoSummary {
  id: string;
  pmoNumber: string;
  title: string;
}

/** 单个当前 WU 的展示快照 + 归属（getAgentSummary 与 instance status_changed 负载共用形状） */
export interface CurrentWuContext {
  currentWorkUnit: AgentCurrentWorkUnit;
  pmo: AgentPmoSummary | null;
  channelId: string | null;
}

export async function loadCurrentWuContexts(
  fileStore: FileStore,
  wuIds: string[],
  listProjects: () => Promise<ProjectData[]>,
): Promise<Map<string, CurrentWuContext>> {
  const contexts = new Map<string, CurrentWuContext>();
  if (wuIds.length === 0) return contexts;

  const idSet = new Set(wuIds);
  const snapshots = (await fileStore.getIndex()).filter(s => idSet.has(s.id));
  if (snapshots.length === 0) return contexts;

  const reqIds = new Set(snapshots.map(s => s.reqId).filter((id): id is string => !!id));
  const [requirements, projects] = await Promise.all([
    reqIds.size > 0
      ? fileStore.listRequirements()
      : Promise.resolve([] as RequirementWithProject[]),
    listProjects().catch(() => [] as ProjectData[]),
  ]);
  const reqById = new Map((requirements as RequirementWithProject[]).map(r => [r.id, r]));
  const projectById = new Map(projects.map(p => [p.id, p]));

  // 决策 4 别名层镜像（RequirementService.get 口径）：REQ-\d+ 先查统一编号 PMO 别名
  // （别名视图 projectId = PMO 自身 id），查不到再回落 legacy REQ 记录
  const getRequirement = async (id: string): Promise<{ projectId?: string | null } | null> => {
    if (/^REQ-\d+$/i.test(id)) {
      const alias = projects.find(p => p.reqAlias === id.toUpperCase());
      if (alias) return { projectId: alias.id };
    }
    return reqById.get(id) ?? null;
  };
  const resolverDeps = {
    getProject: async (id: string) => projectById.get(id) ?? null,
    getRequirement,
  };

  for (const s of snapshots) {
    const projectId = await resolvePmoProjectIdForWU(
      { reqId: s.reqId ?? null, metadata: s.metadata },
      undefined,
      resolverDeps,
    );
    const project = projectId ? projectById.get(projectId) ?? null : null;
    contexts.set(s.id, {
      currentWorkUnit: {
        id: s.id,
        title: parseWuTitle(s.metadata, s.scope),
        type: s.type,
        status: s.status,
        claimedAt: s.claimedAt,
      },
      pmo: project ? { id: project.id, pmoNumber: project.pmoNumber, title: project.title } : null,
      channelId: s.channelId,
    });
  }
  return contexts;
}
