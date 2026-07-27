/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. 决策 12: 频道配置了 defaultProfileId → 无 @ 消息派给默认角色建 WorkUnit
 * 4. plain text → store only
 *
 * 决策 11: 路由层不认识 skill——`+skill名` token 保留在 scope 原文，
 * 由 agent-loop step 时经 parseSkillHintsFromScope 解析（skill-selector.ts）。
 */
import { logger, FileStore, parseChannels } from '@dommaker/studio-shared';
import { channelMessageService } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { resumeWaitingWorkUnit } from '../workunit/waiting-input.js';
import { resolveReqIdForDispatch } from '../requirements/req-binding.js';

const fileStore = new FileStore();
const workUnitService = new WorkUnitService();

/**
 * Detect @mention in message content.
 * Returns the first matched name, or null if no @mention found.
 */
export function detectMention(content: string): string | null {
  const match = content.match(/@([\w-]+)/);
  return match ? match[1] : null;
}

/**
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. 决策 12: 频道配置了 defaultProfileId → 无 @ 消息派给默认角色建 WorkUnit
 * 4. plain text → store without workUnitId（未配置默认角色 = 维持纯存储）
 *
 * F6: 创建 WorkUnit 时绑定工程 — options.workspaceId 显式指定优先，
 * 否则回落到频道 defaultWorkspaceId。
 *
 * REQ 需求编号（vision §5.3）：@mention 派发时绑定需求 —
 * options.reqId 显式指定 > 消息文本 #REQ-XXXX token > 自动新建（best-effort）。
 */
export async function routeMessage(
  channelId: string,
  content: string,
  replyToId?: string,
  fs?: FileStore,
  options?: { workspaceId?: string | null; reqId?: string | null },
) {
  const resolvedFs = fs ?? fileStore;
  // Use resolved FileStore for WorkUnitService (supports test injection)
  const wuService = new WorkUnitService(resolvedFs);

  // Priority 1: Thread reply — inherit workUnitId from parent
  if (replyToId) {
    const found = await resolvedFs.getMessageById(replyToId);
    if (!found) {
      throw new Error(`Replied message ${replyToId} not found`);
    }
    const inheritedWorkUnitId = found.message.workUnitId ?? undefined;
    const message = await channelMessageService.createHumanMessage(
      channelId,
      content,
      replyToId,
      inheritedWorkUnitId,
    );
    // F5: 回复对象是挂起中的 WorkUnit → 解除挂起并把回复注入下一轮 prompt（best-effort）
    if (inheritedWorkUnitId) {
      await resumeWaitingWorkUnit(inheritedWorkUnitId, content, resolvedFs).catch(err =>
        logger.warn('[MessageRouting] Resume waiting WorkUnit failed (non-blocking)', {
          workUnitId: inheritedWorkUnitId,
          error: String(err),
        })
      );
    }
    return message;
  }

  // Priority 2: @mention → create WorkUnit
  const mentionName = detectMention(content);
  if (mentionName) {
    const allProfiles = await resolvedFs.listProfiles({ status: 'active' });
    // F6: 显式 workspaceId 优先，其次频道默认工程
    const channel = await resolvedFs.getChannel(channelId);
    // §9.5: mention 匹配以 channel.members 为界 — 只能 @ 到本频道成员（修越界 bug）。
    // members 为空（历史频道未回填）时回退到全量 active profile 匹配，保持既有行为。
    const memberIds = parseChannels(channel?.members);
    const agent = allProfiles.find(p =>
      p.name === mentionName && (memberIds.length === 0 || memberIds.includes(p.id))
    ) ?? null;
    const scope = content.replace(/@[\w-]+\s*/, '');
    const workspaceId = options?.workspaceId ?? channel?.defaultWorkspaceId ?? null;
    // REQ 需求编号（vision §5.3）：显式 > #REQ-XXXX token > 自动新建。
    // best-effort：绑定失败不阻断 WorkUnit 创建（log + 不带 reqId 继续）。
    const reqId = await resolveReqIdForDispatch({
      explicitReqId: options?.reqId,
      content,
      channelId,
      createdBy: 'mention',
      fileStore: resolvedFs,
    }).catch(err => {
      logger.warn('[MessageRouting] REQ binding failed (non-blocking)', { error: String(err) });
      return null;
    });
    const workUnit = await wuService.create({
      scope,
      channelId,
      type: 'task',
      status: 'unassigned',
      assigneeId: agent?.id ?? null,
      workspaceId,
      reqId,
      metadata: {
        mentionName,
        matched: !!agent,
        creationMode: 'mention',
      },
    });
    logger.info('[MessageRouting] WorkUnit created from @mention', {
      channelId,
      workUnitId: workUnit.id,
      mentionName,
      matched: !!agent,
      workspaceId,
      reqId,
    });
    return channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
    );
  }

  // 决策 12: 无 @ 兜底 —— 频道配置了默认角色 → 派给它建 WorkUnit（消息关联到该 WU）
  const channel = await resolvedFs.getChannel(channelId);
  if (channel?.defaultProfileId) {
    const workUnit = await wuService.create({
      scope: content,
      channelId,
      type: 'task',
      status: 'unassigned',
      assigneeId: channel.defaultProfileId,
      metadata: { creationMode: 'channel-default' },
    });
    logger.info('[MessageRouting] WorkUnit created for channel default profile', {
      channelId,
      workUnitId: workUnit.id,
      defaultProfileId: channel.defaultProfileId,
    });
    return channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
    );
  }

  // Priority 4: Plain storage
  return channelMessageService.createHumanMessage(channelId, content);
}
