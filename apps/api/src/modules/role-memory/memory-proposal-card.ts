/**
 * memory-proposal-card (#101) — 角色记忆草稿的人审提案卡。
 *
 * 与 R3 knowledge_proposal 卡平行：后者审 KnowledgeStore 条目（maturity=draft），本卡审
 * 角色记忆草稿（draft.jsonl pending，review=manual 档）。cardType='memory_proposal'，
 * cardData.entries 指向「文件 + 段落」（topicPath=topics/<slug>.md + 拟写 ## 标题段落），
 * approve→roleMemoryStore.promote / reject→roleMemoryStore.demote（接线见 role-memory.routes）。
 *
 * 发卡失败 / 频道缺失静默跳过（提取链路绝不被通知阻断），同 postKnowledgeProposalCard 降级。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import { resolveTopicSlug, type MemoryDraftEntry, type MemoryKind } from './role-memory.js';

const fileStore = new FileStore();

/** 审核闭环：提案卡投放的目标频道（ensureDefaultChannels 启动播种） */
const SYSTEM_CHANNEL_NAME = '#系统';

/** kind → 人类可读标签（不暴露 execution-knowledge / preference 等内部分类词） */
const KIND_LABELS: Record<MemoryKind, string> = {
  'execution-knowledge': '经验做法',
  preference: '偏好约定',
};

/** 卡片条目：meta 指向文件 + 段落（供 approve/reject 接线 + 人审阅读） */
export interface MemoryProposalCardEntry {
  draftId: string;
  roleId: string;
  title: string;
  topicSlug: string;
  /** 拟写入的记忆文件相对路径（topics/<slug>.md，相对 <roleMemory>/<roleId>/） */
  topicPath: string;
  kind: MemoryKind;
}

/**
 * 聚合本次提取的 manual 档草稿条目发一张 cardType='memory_proposal' 卡到 #系统 频道。
 * 无条目 / 频道缺失 / 发卡失败均静默跳过（提取链路绝不被通知阻断）。
 */
export async function postMemoryProposalCard(
  entries: MemoryDraftEntry[],
  ctx: { workUnitId?: string; source: string },
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const channel = (await fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) return; // 频道未播种 → 静默跳过

    const { channelMessageService } = await import('../channels/channel-message.service.js');
    const cardEntries: MemoryProposalCardEntry[] = entries.map(e => {
      const topicSlug = resolveTopicSlug(e.title, e.topicSlug);
      return {
        draftId: e.id,
        roleId: e.roleId,
        title: e.title,
        topicSlug,
        topicPath: `topics/${topicSlug}.md`,
        kind: e.kind,
      };
    });
    const roleId = entries[0].roleId;

    const content = [
      '## 🧠 角色记忆提案 — 待确认',
      '',
      '以下内容建议沉淀为该角色的长期记忆（保存到其记忆文件）：',
      '',
      ...cardEntries.map((e, i) => `${i + 1}. **${e.title}**（${KIND_LABELS[e.kind] ?? e.kind}）`),
      '',
      ...cardEntries.map(e => `- ${e.title} → \`${e.topicPath}\``),
      '',
      `来源 WorkUnit: ${ctx.workUnitId ?? 'unknown'}`,
      '确认后写入该角色的记忆文件；丢弃则不写入。',
    ].join('\n');

    await channelMessageService.createCardMessage(
      channel.id,
      'KK',
      content,
      'memory_proposal',
      { roleId, entries: cardEntries, workUnitId: ctx.workUnitId ?? null, source: ctx.source },
    );
    logger.info('[RoleMemory] memory_proposal card posted', {
      channel: SYSTEM_CHANNEL_NAME, entryCount: entries.length, workUnitId: ctx.workUnitId, roleId,
    });
  } catch (e) {
    logger.warn('[RoleMemory] Failed to post memory_proposal card', { error: String(e) });
  }
}
