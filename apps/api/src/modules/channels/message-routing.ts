/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. plain text → store only
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
  // \w 只等价于 [A-Za-z0-9_]，中文等 Unicode 名字匹配不到 — 用 \p{L}/\p{N} 放宽
  const match = content.match(/@([\p{L}\p{N}_-]+)/u);
  return match ? match[1] : null;
}

/**
 * §10.3 显式覆盖：解析消息中的 `+skill名` token（全部出现，按序去重）。
 * token 保留在原文中不改写；创建 WorkUnit 时写入 metadata.skillHints。
 */
export function parseSkillHints(content: string): string[] {
  const hints: string[] = [];
  for (const match of content.matchAll(/\+([\w-]+)/g)) {
    if (!hints.includes(match[1])) hints.push(match[1]);
  }
  return hints;
}

/**
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. plain text → store without workUnitId
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
    const scope = content.replace(/@[\p{L}\p{N}_-]+\s*/u, '');
    const skillHints = parseSkillHints(content);
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
        // §10.3: +skill名 显式指定（token 保留在原文中，仅解析进 metadata）
        ...(skillHints.length > 0 ? { skillHints } : {}),
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

  // Priority 3: Plain storage
  return channelMessageService.createHumanMessage(channelId, content);
}
