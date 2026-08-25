/**
 * AC-E2: Convert to Task Service
 *
 * Handles conversion of channel messages to WorkUnits (AC-E1)
 * and LLM-based suggestions for task creation (AC-E2，走 SystemExecutor /
 * studio 角色绑定的 CLI；角色未配置或调用失败时 suggest 返回空建议，非阻断).
 */
import { logger, FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';
import type { WorkUnitData } from '../workunit/workunit.service.js';
import { resolveReqIdForDispatch } from '../requirements/req-binding.js';
import { getSystemExecutor } from '../agents/system-executor.js';

export interface ConvertInput {
  title?: string;
  description?: string;
  assigneeId?: string;
  projectPath?: string;
  workspaceId?: string | null;  // F6: 显式绑定工程（缺省走频道默认）
  reqId?: string | null;        // REQ 需求编号（显式指定；缺省走 token/自动新建）
}

export interface ConvertSuggestion {
  title?: string;
  description?: string;
  suggestedAssigneeId?: string;
  suggestedProjectPath?: string;
}

export class ConvertToTaskService {
  private fileStore: FileStore;
  private workUnitService: WorkUnitService;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
  }

  /**
   * AC-E1: Convert a message to a WorkUnit.
   * Creates WorkUnit via FileStore, links message as thread anchor.
   */
  async convert(channelId: string, messageId: string, input: ConvertInput): Promise<WorkUnitData> {
    // 1. Fetch original message via FileStore
    const found = await this.fileStore.getMessageById(messageId);
    if (!found) {
      throw new Error(`Message ${messageId} not found`);
    }
    if (found.message.workUnitId) {
      throw new Error(`Message already has WorkUnit ${found.message.workUnitId}`);
    }

    // 2. Create WorkUnit via WorkUnitService (FileStore)
    // F6: 显式 workspaceId 优先，其次频道默认工程
    const channel = await this.fileStore.getChannel(channelId);
    // REQ 需求编号（vision §5.3）：显式 > 原消息 #REQ-XXXX token > 自动新建（best-effort）
    const reqId = await resolveReqIdForDispatch({
      explicitReqId: input.reqId,
      content: found.message.content,
      channelId,
      createdBy: 'convert',
      fileStore: this.fileStore,
    }).catch(err => {
      logger.warn('[ConvertToTask] REQ binding failed (non-blocking)', { error: String(err) });
      return null;
    });
    const workUnit = await this.workUnitService.create({
      scope: input.title || found.message.content.slice(0, 500),
      channelId,
      type: 'task',
      // L1（2026-07-28）：有 assigneeId 也建 unassigned——UI 传的是 profile.id（指名语义，
      // §1.2-b），由被指名 profile 的 loop 认领（与 @mention/委派口径一致）。
      // 直接建 active + assigneeId=profile.id 是卡死态：myActive 按 instance.id 续跑查询、
      // 认领过滤要求 unassigned，两边都看不到该 WU（同 d7bd1e8 修过的 ownership resume）。
      status: 'unassigned',
      assigneeId: input.assigneeId ?? null,
      projectPath: input.projectPath ?? null,
      workspaceId: input.workspaceId ?? channel?.defaultWorkspaceId ?? null,
      reqId,
      metadata: {
        creationMode: 'convert',
        originalMessageId: messageId,
        description: input.description,
      },
    });

    // 3. Link message to WorkUnit via FileStore (append updated copy)
    // #332：createdAt = 诞生时刻不可变（ADR 2026-08-24），关联 WU 不 bump
    const updatedMsg: ChannelMessageData = {
      ...found.message,
      workUnitId: workUnit.id,
    };
    await this.fileStore.appendMessage(found.channelId, updatedMsg);

    return workUnit;
  }

  /**
   * AC-E2: LLM-based suggestion for converting a message to a task.
   * Returns empty suggestion on failure (non-blocking).
   */
  async suggest(
    messageContent: string,
    agents: Array<{ id: string; name: string; description?: string }>,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion> {
    if (!messageContent || !messageContent.trim()) {
      return {};
    }

    try {
      const result = await this.callLLM(messageContent, agents, projects);
      return result;
    } catch (error) {
      logger.warn('[ConvertToTask] LLM suggestion failed (non-blocking)', { error: String(error) });
      return {};
    }
  }

  /** Internal LLM call — exposed for testing */
  async callLLM(
    messageContent: string,
    agents: Array<{ id: string; name: string; description?: string }>,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion> {
    const agentList = agents.map(a => `- ${a.name} (id: ${a.id})${a.description ? `: ${a.description}` : ''}`).join('\n');
    const projectList = projects.map(p => `- ${p.name} (${p.path})`).join('\n');

    const systemPrompt = `You are a task creation assistant. Analyze the message and suggest:
- title: a short task title
- description: a brief description
- suggestedAssigneeId: the best agent ID from the list (or null)
- suggestedProjectPath: the best project path from the list (or null)

Available agents:
${agentList || '(none)'}

Available projects:
${projectList || '(none)'}

Return JSON only: {"title":"...","description":"...","suggestedAssigneeId":"...","suggestedProjectPath":"..."}`;

    // LLM 调用走 SystemExecutor（studio 角色绑定的 CLI）；角色未配置/失败由 suggest() 兜空
    const parsed = await getSystemExecutor().runJson<{
      title?: string;
      description?: string;
      suggestedAssigneeId?: string;
      suggestedProjectPath?: string;
    }>(messageContent, { systemPrompt, timeoutMs: 15_000 });

    return {
      title: parsed.title || undefined,
      description: parsed.description || undefined,
      suggestedAssigneeId: parsed.suggestedAssigneeId || undefined,
      suggestedProjectPath: parsed.suggestedProjectPath || undefined,
    };
  }
}
