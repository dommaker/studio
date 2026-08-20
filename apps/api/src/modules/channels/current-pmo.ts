/**
 * #272（决策 #251 Q1/Q6）：频道「当前 PMO」派生。
 *
 * 派生概念不落库（channel 不加 pmoId 字段，守住 D2 归属锚在 PMO）：
 *   本频道最近挂接 REQ（seq 大→小）所属 PMO → 无挂接 REQ 时回退杂务 PMO
 *   （isChore + channelId，只查不建）→ 都没有 → null（顶栏 chip 不渲染）。
 *
 * 返回 chip 呈现所需最小形状；gitRepos = gitRepo + deliveries 多腿
 * （复用 file-ref-vocabulary 的 reposOfProject，与候选集口径一致）。
 * 各来源独立容错：单步读取失败记日志并顺延/回退，派生绝不抛出。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { projectService } from '../pmo/project.service.js';
import { reposOfProject, listChannelReqPmoProjects, type ProjectLike } from './file-ref-vocabulary.js';

/** 顶栏当前 PMO chip 的呈现形状（多仓 PMO 只显名称，gitRepos 走 tooltip） */
export interface ChannelCurrentPmo {
  id: string;
  pmoNumber: string;
  title: string;
  gitRepos: string[];
}

/** 派生所需的项目最小形状（chip 字段 + 仓路径来源） */
export interface CurrentPmoProject extends ProjectLike {
  id: string;
  pmoNumber?: string;
  title: string;
}

export interface CurrentPmoDeps {
  fileStore?: FileStore;
  /** 默认 projectService.get */
  getProject?: (projectId: string) => Promise<CurrentPmoProject | null>;
  /** 默认 projectService.findChoreProject（只查不建，热路径零副作用） */
  findChoreProject?: (channelId: string) => Promise<CurrentPmoProject | null>;
}

function toChip(project: CurrentPmoProject): ChannelCurrentPmo {
  return {
    id: project.id,
    pmoNumber: project.pmoNumber ?? '',
    title: project.title,
    gitRepos: reposOfProject(project),
  };
}

/** 派生频道当前 PMO；无派生结果返回 null（调用方不渲染 chip） */
export async function deriveChannelCurrentPmo(
  channelId: string,
  deps: CurrentPmoDeps = {},
): Promise<ChannelCurrentPmo | null> {
  const fileStore = deps.fileStore ?? new FileStore();
  const getProject = deps.getProject ?? (async (id: string) => projectService.get(id));
  const findChoreProject = deps.findChoreProject ?? (async (id: string) => projectService.findChoreProject(id));

  // 1. 最近挂接 REQ 所属 PMO（seq 大→小；项目缺失/读取失败已在共用查询内顺延跳过）
  try {
    const links = await listChannelReqPmoProjects(channelId, { fileStore, getProject });
    const attached = links.sort((a, b) => b.seq - a.seq);
    if (attached.length > 0) return toChip(attached[0].project);
  } catch (err) {
    logger.warn('[CurrentPmo] Requirement listing failed, falling back to chore PMO', {
      channelId, error: String(err),
    });
  }

  // 2. 杂务 PMO 反推（只查不建）
  try {
    const chore = await findChoreProject(channelId);
    if (chore) return toChip(chore);
  } catch (err) {
    logger.warn('[CurrentPmo] Chore PMO resolution failed', { channelId, error: String(err) });
  }

  return null;
}
