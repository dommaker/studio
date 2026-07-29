/**
 * PMO-b（2026-07-28 分析文档 §4.5，决策 3）：WU → PMO 分支解析。
 *
 * per-WU 临时分支（task/<wuId>）的 base 与合并目标从「仓库默认分支」改为
 * 「PMO 分支」（分支名 = PMO id，project.gitBranch 默认 = pmoNumber）。
 * 解析链（任一命中即止，逐级容错，全失败返回 null = 无 PMO 关联，调用方回落现状）：
 *   1. metadata.ownershipProjectId（B3a 归属链审计字段，requirement 来源落档）
 *   2. wu.reqId → Requirement（决策 4 别名感知）→ projectId → PMO
 */
import { FileStore } from '@dommaker/studio-shared';
import { projectService, resolveDeliveryPolicy, type DeliveryPolicy, type ProjectData } from '../pmo/project.service.js';
import { RequirementService } from './requirement.service.js';

export interface PmoBranchResolution {
  projectId: string;
  /** PMO 分支名（gitBranch 缺省回落 pmoNumber——分支名 = PMO id） */
  branch: string;
  deliveryPolicy: DeliveryPolicy;
}

export interface PmoBranchResolverDeps {
  getProject?: (id: string) => Promise<ProjectData | null>;
  getRequirement?: (reqId: string) => Promise<{ projectId?: string | null } | null>;
}

function parseOwnershipProjectId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { ownershipProjectId?: unknown };
    return typeof meta.ownershipProjectId === 'string' && meta.ownershipProjectId
      ? meta.ownershipProjectId
      : null;
  } catch {
    return null;
  }
}

export async function resolvePmoBranchForWU(
  wu: { reqId?: string | null; metadata?: string | null },
  fileStore?: FileStore,
  deps?: PmoBranchResolverDeps,
): Promise<PmoBranchResolution | null> {
  const getProject = deps?.getProject ?? (async (id: string) => projectService.get(id));
  const getRequirement = deps?.getRequirement
    ?? (async (id: string) => new RequirementService(fileStore).get(id));

  let project: ProjectData | null = null;

  // 1. metadata.ownershipProjectId 直查
  const ownershipProjectId = parseOwnershipProjectId(wu.metadata);
  if (ownershipProjectId) {
    project = await getProject(ownershipProjectId).catch(() => null);
  }

  // 2. reqId → REQ（别名视图 projectId = PMO 自身 id）→ PMO
  if (!project && wu.reqId) {
    const req = await getRequirement(wu.reqId).catch(() => null);
    if (req?.projectId) {
      project = await getProject(req.projectId).catch(() => null);
    }
  }

  if (!project) return null;
  const branch = project.gitBranch || project.pmoNumber;
  if (!branch) return null;
  return { projectId: project.id, branch, deliveryPolicy: resolveDeliveryPolicy(project) };
}
