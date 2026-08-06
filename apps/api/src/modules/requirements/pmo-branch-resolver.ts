/**
 * PMO-b（2026-07-28 分析文档 §4.5，决策 3）：WU → PMO 分支解析。
 *
 * per-WU 临时分支（task/<wuId>）的 base 与合并目标从「仓库默认分支」改为
 * 「PMO 分支」（分支名 = PMO id，project.gitBranch 默认 = pmoNumber）。
 *
 * 2026-08 归因统一：canonical metadata key = `pmoId`（创建期一次性落档，
 * 见 wu-pmo-attribution.ts）。解析链（两个逻辑级，逐级容错、逐级校验项目存在，
 * 全失败返回 null = 无 PMO 关联，调用方回落现状）：
 *   1. 创建期直读戳：metadata.pmoId ‖ metadata.ownershipProjectId（deprecated legacy 同位兼容读，同级）
 *   2. wu.reqId → Requirement（决策 4 别名感知）→ projectId → PMO
 * （2026-08 前的 ③ metadata.pmoProjectId 级已移除——那是 agent-loop 首 step 落档的
 *  冗余缓存，生产存量为零；本次修复 analysis 派生链 task WU（仅 pmoId、reqId=null）
 *  永远解析不到 PMO 分支、代码合并未走 PMO 集成分支的 bug。）
 */
import { FileStore } from '@dommaker/studio-shared';
import { projectService, resolveDeliveryPolicy, type DeliveryPolicy, type ProjectData } from '../pmo/project.service.js';
import { RequirementService } from './requirement.service.js';
import { parseWuPmoId } from './wu-pmo-attribution.js';

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

/**
 * 共享归因链（两个 resolve 投影的共同实现）：
 *   ① 创建期直读戳（metadata.pmoId ‖ legacy ownershipProjectId）→ 项目存在
 *   ② wu.reqId → Requirement.projectId（决策 4 别名感知由 getRequirement 实现侧保证）→ 项目存在
 * 逐级容错（单级读取失败/项目不存在 → 继续下一级），全失败返回 null = 无 PMO 归属。
 */
async function resolveAttribution(
  wu: { reqId?: string | null; metadata?: string | null },
  fileStore?: FileStore,
  deps?: PmoBranchResolverDeps,
): Promise<ProjectData | null> {
  const getProject = deps?.getProject ?? (async (id: string) => projectService.get(id));
  const getRequirement = deps?.getRequirement
    ?? (async (id: string) => new RequirementService(fileStore).get(id));

  // 1. 创建期直读戳：metadata.pmoId ‖ legacy ownershipProjectId（同级，pmoId 优先）
  const stampedProjectId = parseWuPmoId(wu.metadata);
  if (stampedProjectId) {
    const project = await getProject(stampedProjectId).catch(() => null);
    if (project) return project;
  }

  // 2. reqId → REQ（别名视图 projectId = PMO 自身 id）→ PMO
  if (wu.reqId) {
    const req = await getRequirement(wu.reqId).catch(() => null);
    if (req?.projectId) {
      return await getProject(req.projectId).catch(() => null);
    }
  }

  return null;
}

export async function resolvePmoBranchForWU(
  wu: { reqId?: string | null; metadata?: string | null },
  fileStore?: FileStore,
  deps?: PmoBranchResolverDeps,
): Promise<PmoBranchResolution | null> {
  const project = await resolveAttribution(wu, fileStore, deps);
  if (!project) return null;
  const branch = project.gitBranch || project.pmoNumber;
  if (!branch) return null;
  return { projectId: project.id, branch, deliveryPolicy: resolveDeliveryPolicy(project) };
}

/**
 * 2026-07 PMO-flow UX（设计文档 §6）：WU → 归属 PMO 项目 id 解析（只出项目 id，
 * 不含分支/交付策略——无 gitBranch/pmoNumber 的项目也能命中）。
 * 解析链与 resolvePmoBranchForWU 完全同序（共享 resolveAttribution，见文件头）。
 * 消费方：monitoring /agents 聚合（注入 map 版 deps 批量内存匹配，避免逐 WU 读文件）、
 * agent-loop / ReviewDispatcher / timeout-release / merge-on-review-pass 里程碑消息 meta.pmoId。
 */
export async function resolvePmoProjectIdForWU(
  wu: { reqId?: string | null; metadata?: string | null },
  fileStore?: FileStore,
  deps?: PmoBranchResolverDeps,
): Promise<string | null> {
  const project = await resolveAttribution(wu, fileStore, deps);
  return project?.id ?? null;
}
