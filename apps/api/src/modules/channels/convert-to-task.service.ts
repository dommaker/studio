/**
 * AC-E2: Convert to Task Service
 *
 * Handles conversion of channel messages to WorkUnits (AC-E1)
 * and LLM-based suggestions for task creation (AC-E2，走 SystemExecutor /
 * studio 角色绑定的 CLI；角色未配置或调用失败时 suggest 返回空建议，非阻断).
 */
import { FileStore, parseChannels } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/index.js';
import type { WorkUnitData } from '../workunit/index.js';
import { ChannelMessageService, getChannelMessageService, type MessageMeta } from './channel-message.service.js';
import { buildOwnershipMetadata, postOwnershipQuestion } from './wu-dispatch.js';
import { resolveReqIdForDispatch, resolveWorkspaceForWU } from '../requirements/index.js';
import { getSystemExecutor } from '../agents/index.js';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';

export interface ConvertInput {
  title?: string;
  description?: string;
  assigneeId?: string;
  projectPath?: string;
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
  private messageService: ChannelMessageService;

  constructor(fileStore?: FileStore, messageService?: ChannelMessageService) {
    this.fileStore = fileStore ?? getStore();
    this.workUnitService = new WorkUnitService(this.fileStore);
    // #333：关联 WU 走 ChannelMessageService 统一更新路径（自带 channel.message_updated 双发）；
    // 注入口径：可注入；缺省 fileStore 新建 ChannelMessageService，无 fileStore 用单例
    this.messageService = messageService ?? (fileStore ? new ChannelMessageService(fileStore) : getChannelMessageService());
  }

  /**
   * AC-E1: Convert a message to a WorkUnit.
   * Creates WorkUnit via FileStore, links message as thread anchor.
   */
  async convert(channelId: string, messageId: string, input: ConvertInput): Promise<WorkUnitData> {
    // 1. Fetch original message via FileStore（#524 P1-1：频道已知，按频道直查免全频道扇出）
    const found = await this.fileStore.getMessageById(messageId, channelId);
    if (!found) {
      throw new Error(`Message ${messageId} not found`);
    }
    if (found.message.workUnitId) {
      throw new Error(`Message already has WorkUnit ${found.message.workUnitId}`);
    }
    if (input.assigneeId) {
      const channel = await this.fileStore.getChannel(channelId);
      const memberIds = parseChannels(channel?.members);
      if (!memberIds.includes(input.assigneeId)) {
        throw new Error(`Assignee ${input.assigneeId} is not a channel member`);
      }
    }

    // 2. Create WorkUnit via WorkUnitService (FileStore)
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
    // #700：与 mention/new-task 共用同一 REQ/#PMO 别名及工程归属链；显式 projectPath 优先。
    let messageMeta: MessageMeta = {};
    try {
      messageMeta = typeof found.message.meta === 'string'
        ? JSON.parse(found.message.meta) as MessageMeta
        : found.message.meta ?? {};
    } catch { /* 畸形 meta 按无文件引用处理 */ }
    const ownership = await resolveWorkspaceForWU({
      explicitWorkspaceRoot: input.projectPath,
      reqId,
      channelId,
      fileRefs: messageMeta.files,
      fileStore: this.fileStore,
    }).catch(err => {
      logger.warn('[ConvertToTask] Ownership resolution failed, continuing without attribution', { error: String(err) });
      return null;
    });
    const parked = ownership?.source === 'none';
    const workUnit = await this.workUnitService.create({
      scope: input.title || found.message.content.slice(0, 500),
      channelId,
      type: 'task',
      // L1（2026-07-28）：有归属且有 assigneeId 也建 unassigned——UI 传的是 profile.id
      // （指名语义），由被指名 profile 的 loop 认领；无归属时与频道建单同样挂起澄清。
      status: parked ? 'blocked' : 'unassigned',
      assigneeId: input.assigneeId ?? undefined,
      projectPath: input.projectPath ?? null,
      reqId,
      metadata: {
        creationMode: 'convert',
        originalMessageId: messageId,
        anchorMessageId: messageId,
        description: input.description,
        ...buildOwnershipMetadata(ownership, parked),
      },
    });

    // 3. Link message to WorkUnit —— #333：经 ChannelMessageService 统一更新路径
    // （append 新版保留原 createdAt，自带 eventBus + SSE channel.message_updated 双发）
    await this.messageService.linkWorkUnit(messageId, workUnit.id, channelId);
    if (parked) await postOwnershipQuestion(workUnit, messageId, this.fileStore);

    return workUnit;
  }

  /**
   * AC-E2: LLM-based suggestion for converting a message to a task.
   * Returns empty suggestion on failure (non-blocking).
   */
  async suggest(
    channelId: string,
    messageContent: string,
    projects: Array<{ name: string; path: string }>,
  ): Promise<ConvertSuggestion> {
    if (!messageContent || !messageContent.trim()) {
      return {};
    }

    try {
      // 只把显式 active 频道成员提供给 LLM；空频道候选为空（#699）
      const [profiles, channel] = await Promise.all([
        this.fileStore.listProfiles({ status: 'active' }),
        this.fileStore.getChannel(channelId),
      ]);
      const memberIds = parseChannels(channel?.members);
      const agents = profiles
        .filter(p => memberIds.includes(p.id))
        .map(p => ({ id: p.id, name: p.name, description: p.description ?? undefined }));
      return await this.callLLM(messageContent, agents, projects);
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
    }>(messageContent, { systemPrompt, timeoutMs: 15_000, eventSource: 'convert-to-task' });

    return {
      title: parsed.title || undefined,
      description: parsed.description || undefined,
      suggestedAssigneeId: parsed.suggestedAssigneeId || undefined,
      suggestedProjectPath: parsed.suggestedProjectPath || undefined,
    };
  }
}
