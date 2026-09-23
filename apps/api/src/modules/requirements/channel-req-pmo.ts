/**
 * 频道 REQ 挂接 PMO 查询原语（#636 自 channels/file-ref-vocabulary 下沉）：
 * channels 是 requirements 的下游（channels 已 import requirements），
 * requirements 不可反向 import channels，派生核心查询须落在 requirements 可达位置。
 *
 * - `listChannelReqPmoProjects`：computeCandidateRepos 候选集与 current-pmo 派生
 *   共用的查询原语。REQ 列表读取失败 → 抛出（两调用方降级路径不同，各自兜底）；
 *   单条 projectId 解析抛错/项目不存在 → 记日志跳过，不影响其他条目。
 * - `deriveChannelReqPmo`：current-pmo 派生链第一级——本频道最近挂接 REQ
 *   （seq 大→小）所属 PMO。杂务回退级不在此（由调用方既有归集覆盖）。
 *   只查不建、零副作用；读取失败记日志返回 null，绝不抛出
 *   （与 current-pmo「各来源独立容错、派生绝不抛出」同原则）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { projectService } from '../pmo/project.service.js';

/** PMO 工程的最小形状（查询本身不读字段，仅作泛型约束） */
export interface ProjectLike {
  gitRepo?: string | null;
  deliveries?: Array<{ gitRepo?: string | null }>;
}

/** 频道 REQ 挂接 PMO 工程的一条关联（seq 供调用方决定排序） */
export interface ChannelReqPmoLink<P extends ProjectLike = ProjectLike> {
  reqId: string;
  seq: number;
  projectId: string;
  project: P;
}

/**
 * 频道 REQ 挂接 PMO 工程清单（Requirement.channelId → projectId → PMO 逐条容错遍历）。
 * REQ 列表读取失败 → 抛出（调用方各自兜底）；单条解析失败/项目缺失 → 记日志跳过。
 * B7（2026-09-16 channel 性能审计）：多项目解析并行发出（Promise.all），保输入序。
 */
export async function listChannelReqPmoProjects<P extends ProjectLike>(
  channelId: string,
  deps: {
    fileStore?: FileStore;
    /** 默认 projectService.get */
    getProject?: (projectId: string) => Promise<P | null>;
  } = {},
): Promise<ChannelReqPmoLink<P>[]> {
  const fileStore = deps.fileStore ?? new FileStore();
  const getProject = deps.getProject
    ?? (async (id: string) => (await projectService.get(id)) as unknown as P | null);
  const requirements = await fileStore.listRequirements({ channelId });
  const results = await Promise.all(requirements.map(async (req): Promise<ChannelReqPmoLink<P> | null> => {
    const projectId = (req as { projectId?: string | null }).projectId;
    if (!projectId) return null;
    try {
      const project = await getProject(projectId);
      return project ? { reqId: req.id, seq: req.seq, projectId, project } : null;
    } catch (err) {
      logger.warn('[ChannelReqPmo] REQ project resolution failed, skipped', {
        channelId, reqId: req.id, projectId, error: String(err),
      });
      return null;
    }
  }));
  return results.filter((l): l is ChannelReqPmoLink<P> => l !== null);
}

/**
 * #636：current-pmo 派生链第一级 —— 本频道最近挂接 REQ（seq 大→小）所属 PMO。
 * 无挂接 / 读取失败 → null（记日志，绝不抛出）。杂务回退级由调用方既有归集覆盖。
 */
export async function deriveChannelReqPmo<P extends ProjectLike>(
  channelId: string,
  deps: {
    fileStore?: FileStore;
    /** 默认 projectService.get */
    getProject?: (projectId: string) => Promise<P | null>;
  } = {},
): Promise<P | null> {
  try {
    const links = await listChannelReqPmoProjects(channelId, deps);
    links.sort((a, b) => b.seq - a.seq);
    return links[0]?.project ?? null;
  } catch (err) {
    logger.warn('[ChannelReqPmo] Derivation failed, returning null', { channelId, error: String(err) });
    return null;
  }
}
