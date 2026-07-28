/**
 * B3a 工程归属链（决策 D2）— WorkUnit 创建时的工程归属解析。
 *
 * 第一性归属链：OKR → PMO 项目（gitRepo 锚点）→ Requirement（挂 PMO 项目）
 * → WU（从 Requirement 继承工程）→ 执行。频道绑定降级为默认提示。
 *
 * 优先级：显式 workspaceId > Requirement.projectId → PMO 项目 gitRepo
 * > 频道 defaultWorkspaceId > 无归属（none → 调用方转 NEED_INPUT 问人）。
 *
 * 各步独立容错：需求/项目/频道读取失败仅记日志并落到下一优先级，
 * 归属解析绝不阻断 WorkUnit 创建。
 *
 * 来源为 requirement 时返回的 workspaceRoot 是 PMO 项目 gitRepo 原始路径，
 * 以 metadata.workspaceRoot 字符串形式进入 WU，agent-loop 直接作为执行根目录
 * （与 task.parameters.workspaceRoot 消费方式兼容，不经 workspace 记录解析）。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { projectService } from '../pmo/project.service.js';
import type { RequirementWithProject } from './requirement.service.js';

/** 无归属挂起时的提问文案（message-routing 建 WU 时写入 metadata.waitingQuestion） */
export const OWNERSHIP_WAITING_QUESTION = '这个任务要修改哪个工程？请回复工程名或路径';

/** 归属来源 — 写入 WU metadata.ownershipSource，供日志与审计区分 */
export type OwnershipSource = 'explicit' | 'requirement' | 'channel-default' | 'none';

export interface OwnershipResolution {
  source: OwnershipSource;
  /** workspace 记录 id（explicit / channel-default 来源；执行时经 workspace 记录解析根目录） */
  workspaceId: string | null;
  /** 直接可用的工程根路径（requirement 来源：PMO 项目 gitRepo） */
  workspaceRoot: string | null;
  /** 经 Requirement 解析到的 PMO 项目 id（审计用；非 requirement 来源为 null） */
  projectId: string | null;
}

export interface ResolveWorkspaceInput {
  /** 消息 API body 显式指定的 workspaceId（最高优先级） */
  explicitWorkspaceId?: string | null;
  /** 本次派发绑定的 REQ id（经其 projectId 查 PMO 项目 gitRepo） */
  reqId?: string | null;
  /** 来源频道（defaultWorkspaceId 默认提示） */
  channelId?: string | null;
  fileStore?: FileStore;
  /** 项目查询（可注入，测试用 stub 避免碰真实 ~/.studio/projects） */
  getProject?: (projectId: string) => Promise<{ gitRepo?: string | null } | null>;
}

const NONE: OwnershipResolution = { source: 'none', workspaceId: null, workspaceRoot: null, projectId: null };

/**
 * 解析本次派发 WorkUnit 的工程归属。
 * 各优先级独立 try/catch：单步读取失败记日志并落到下一优先级。
 */
export async function resolveWorkspaceForWU(input: ResolveWorkspaceInput): Promise<OwnershipResolution> {
  // 1. 显式 workspaceId（调用方明确指定，不校验存在性 — 与旧 F6 行为一致）
  if (input.explicitWorkspaceId) {
    return { source: 'explicit', workspaceId: input.explicitWorkspaceId, workspaceRoot: null, projectId: null };
  }

  const fileStore = input.fileStore ?? new FileStore();

  // 2. Requirement → PMO 项目 gitRepo（第一性归属）
  if (input.reqId) {
    try {
      const requirement = (await fileStore.getRequirement(input.reqId)) as RequirementWithProject | null;
      const projectId = requirement?.projectId ?? null;
      if (projectId) {
        const getProject = input.getProject ?? (async (id: string) => projectService.get(id));
        const project = await getProject(projectId);
        if (project?.gitRepo) {
          return { source: 'requirement', workspaceId: null, workspaceRoot: project.gitRepo, projectId };
        }
      }
    } catch (err) {
      logger.warn('[Ownership] Requirement/project resolution failed, falling through', {
        reqId: input.reqId,
        error: String(err),
      });
    }
  }

  // 3. 频道 defaultWorkspaceId（降级为默认提示）
  if (input.channelId) {
    try {
      const channel = await fileStore.getChannel(input.channelId);
      if (channel?.defaultWorkspaceId) {
        return { source: 'channel-default', workspaceId: channel.defaultWorkspaceId, workspaceRoot: null, projectId: null };
      }
    } catch (err) {
      logger.warn('[Ownership] Channel default workspace resolution failed, falling through', {
        channelId: input.channelId,
        error: String(err),
      });
    }
  }

  // 4. 无归属 → 调用方转 NEED_INPUT 问人
  return NONE;
}
