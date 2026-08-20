/**
 * #278（决策 #250 D2）：auditor_suggestion 卡的人审决策服务。
 *
 * 采纳（confirm）= 在本频道建一张 type:'task' 的未指派工单
 * （正文 = 建议详情 + 原卡链接，unassigned 待认领，走既有执行链——
 *  禁止建 active + assigneeId=profile.id 卡死态，见 convert-to-task.service.ts L1 注释）；
 * 拒绝（reject）= 仅留痕。
 * 状态经 channelMessageService.updateMessageMeta 回写 meta.status（自带
 * eventBus + SSE channel.message_updated 推送，多端状态一致）。
 *
 * 不复活已删的通用 actions 端点（AC-A5 刻意决策）——本服务只服务 auditor_suggestion 卡。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit/workunit.service.js';
import type { WorkUnitData } from '../workunit/workunit.service.js';
import { ChannelMessageService, channelMessageService } from './channel-message.service.js';
import { parseMessageMeta } from '../../utils/message-meta.js';

export type CardDecision = 'confirm' | 'reject';

export interface CardDecisionResult {
  status: 'confirmed' | 'rejected';
  workUnitId?: string;
}

interface AuditorSuggestion {
  type?: string;
  risk?: string;
  skillName?: string;
  agentType?: string;
  detail?: string;
}

const DECIDED_STATUSES = new Set(['confirmed', 'rejected']);

export class CardDecisionService {
  private fileStore: FileStore;
  private messageService: ChannelMessageService;
  private workUnitService: WorkUnitService;

  constructor(fileStore?: FileStore, messageService?: ChannelMessageService) {
    this.fileStore = fileStore ?? new FileStore();
    this.messageService = messageService ?? (fileStore ? new ChannelMessageService(fileStore) : channelMessageService);
    this.workUnitService = new WorkUnitService(this.fileStore);
  }

  async decide(channelId: string, messageId: string, decision: CardDecision): Promise<CardDecisionResult> {
    const found = await this.fileStore.getMessageById(messageId);
    if (!found || found.message.channelId !== channelId) {
      throw new Error(`Message ${messageId} not found in channel ${channelId}`);
    }

    const meta = parseMessageMeta(found.message.meta);
    if (meta.cardType !== 'auditor_suggestion') {
      throw new Error(`Card type '${String(meta.cardType)}' does not support card-decision (only auditor_suggestion)`);
    }
    if (DECIDED_STATUSES.has(String(meta.status))) {
      throw new Error(`Card ${messageId} already decided: ${String(meta.status)}`);
    }

    if (decision === 'reject') {
      // 拒绝 = 仅留痕
      await this.messageService.updateMessageMeta(messageId, { status: 'rejected' });
      logger.info('[CardDecision] Auditor suggestion rejected', { channelId, messageId });
      return { status: 'rejected' };
    }

    // 采纳 = 建本频道未指派 task 工单（正文 = 建议详情 + 原卡链接）
    const cardData = (meta.cardData ?? {}) as { suggestions?: AuditorSuggestion[] };
    const suggestions = Array.isArray(cardData.suggestions) ? cardData.suggestions : [];
    const detailLines = suggestions.map(s =>
      `- [${s.type ?? 'unknown'}${s.risk === 'high' ? '/高风险' : ''}] ${s.detail ?? ''}`.trim(),
    );
    const description = [
      '审计建议采纳（Auditor 建议卡）：',
      '',
      ...(detailLines.length > 0 ? detailLines : [found.message.content]),
      '',
      `原卡：频道 ${channelId} 消息 ${messageId}`,
    ].join('\n');
    const scopeSource = detailLines.length > 0
      ? detailLines.map(l => l.replace(/^- \[[^\]]*\]\s*/, '')).join('；')
      : found.message.content;

    const channel = await this.fileStore.getChannel(channelId);
    const workUnit: WorkUnitData = await this.workUnitService.create({
      scope: `审计建议：${scopeSource}`.slice(0, 500),
      channelId,
      type: 'task',
      status: 'unassigned',
      assigneeId: null,
      workspaceId: channel?.defaultWorkspaceId ?? null,
      metadata: {
        creationMode: 'card-decision',
        originalMessageId: messageId,
        description,
      },
    });

    await this.messageService.updateMessageMeta(messageId, { status: 'confirmed', workUnitId: workUnit.id });
    logger.info('[CardDecision] Auditor suggestion confirmed → task created', {
      channelId, messageId, workUnitId: workUnit.id,
    });
    return { status: 'confirmed', workUnitId: workUnit.id };
  }
}
