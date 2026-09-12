/**
 * B3a 工程归属链（决策 D2）— WorkUnit 创建时的工程归属解析。
 *
 * 第一性归属链：OKR → PMO 项目（gitRepo 锚点）→ Requirement（挂 PMO 项目）
 * → WU（从 Requirement 继承工程）→ 执行。频道绑定降级为默认提示。
 *
 * 优先级：Requirement.projectId → PMO 项目 gitRepo
 * > 文件引用（#285 决策 #249 §4：全部引用同仓时该仓即归属工程）
 * > 频道 defaultPath（#272 决策 #251 Q2'：默认工程=本地 repo）
 * > 无归属（none → 调用方转 NEED_INPUT 问人）。
 *
 * #481（2026-09-11）：原链首尾的「显式 workspaceId」与「频道 defaultWorkspaceId
 * （默认执行机器）」两级已退役——机器指针不再产出（workspace 记录的 root 是启动时
 * 一次性抄件，已退出执行面；channel.defaultWorkspaceId 仅供 file-ref-vocabulary
 * 候选集与绑定存在性校验使用）。
 *
 * 各步独立容错：需求/项目/频道读取失败仅记日志并落到下一优先级，
 * 归属解析绝不阻断 WorkUnit 创建。
 *
 * 来源为 requirement 时返回的 workspaceRoot 是 PMO 项目 gitRepo 原始路径，
 * 以 metadata.workspaceRoot 字符串形式进入 WU，agent-loop 直接作为执行根目录
 * （与 task.parameters.workspaceRoot 消费方式兼容，不经 workspace 记录解析）。
 */
import { logger, FileStore, stripTrailingSlashes } from '@dommaker/studio-shared';
import { projectService } from '../pmo/project.service.js';
import type { RequirementWithProject } from './requirement.service.js';

/** 无归属挂起时的提问文案（message-routing 建 WU 时写入 metadata.waitingQuestion） */
export const OWNERSHIP_WAITING_QUESTION = '这个任务要修改哪个工程？请回复工程名或路径';

/** 归属来源 — 写入 WU metadata.ownershipSource，供日志与审计区分 */
export type OwnershipSource = 'requirement' | 'file-refs' | 'channel-default-path' | 'none';

export interface OwnershipResolution {
  source: OwnershipSource;
  /** 直接可用的工程根路径（requirement 来源：PMO 项目 gitRepo） */
  workspaceRoot: string | null;
  /** 经 Requirement 解析到的 PMO 项目 id（审计用；非 requirement 来源为 null） */
  projectId: string | null;
}

export interface ResolveWorkspaceInput {
  /** 本次派发绑定的 REQ id（经其 projectId 查 PMO 项目 gitRepo） */
  reqId?: string | null;
  /** 来源频道（defaultPath 默认工程，降级提示） */
  channelId?: string | null;
  /** #285（决策 #249 §4）：@文件引用（路由层校验后的 kept refs；全部引用同仓时该仓即归属工程） */
  fileRefs?: { repo: string; path: string }[];
  fileStore?: FileStore;
  /** 项目查询（可注入，测试用 stub 隔离 PMO 依赖） */
  getProject?: (projectId: string) => Promise<{ gitRepo?: string | null } | null>;
}

const NONE: OwnershipResolution = { source: 'none', workspaceRoot: null, projectId: null };

/**
 * 解析本次派发 WorkUnit 的工程归属。
 * 各优先级独立 try/catch：单步读取失败记日志并落到下一优先级。
 */
export async function resolveWorkspaceForWU(input: ResolveWorkspaceInput): Promise<OwnershipResolution> {
  const fileStore = input.fileStore ?? new FileStore();

  // 1. Requirement → PMO 项目 gitRepo（第一性归属）
  if (input.reqId) {
    try {
      const requirement = (await fileStore.getRequirement(input.reqId)) as RequirementWithProject | null;
      const projectId = requirement?.projectId ?? null;
      if (projectId) {
        const getProject = input.getProject ?? (async (id: string) => projectService.get(id));
        const project = await getProject(projectId);
        if (project?.gitRepo) {
          return { source: 'requirement', workspaceRoot: project.gitRepo, projectId };
        }
      }
    } catch (err) {
      logger.warn('[Ownership] Requirement/project resolution failed, falling through', {
        reqId: input.reqId,
        error: String(err),
      });
    }
  }

  // 2. 文件引用（#285 决策 #249 §4）：全部引用尾斜杠归一后同仓 → 该仓即归属工程；
  //    跨多仓引用不参与归属（落到下一优先级）；空数组等同无引用。
  if (input.fileRefs && input.fileRefs.length > 0) {
    try {
      const repos = input.fileRefs.map(r =>
        typeof r?.repo === 'string' ? stripTrailingSlashes(r.repo) : '');
      // 任一引用 repo 缺失/畸形 = 不满足「全部同仓」，不参与归属
      if (repos.every(r => r.length > 0) && new Set(repos).size === 1) {
        return { source: 'file-refs', workspaceRoot: repos[0], projectId: null };
      }
    } catch (err) {
      logger.warn('[Ownership] File-refs resolution failed, falling through', { error: String(err) });
    }
  }

  // 3. 频道 defaultPath（#272 决策 #251 Q2'：默认工程 = 本地 repo，直接作执行根）
  if (input.channelId) {
    try {
      const channel = await fileStore.getChannel(input.channelId);
      if (channel?.defaultPath) {
        return { source: 'channel-default-path', workspaceRoot: channel.defaultPath, projectId: null };
      }
    } catch (err) {
      logger.warn('[Ownership] Channel default path resolution failed, falling through', {
        channelId: input.channelId,
        error: String(err),
      });
    }
  }

  // 4. 无归属 → 调用方转 NEED_INPUT 问人
  return NONE;
}
