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
import { resumeWaitingWorkUnit, postStudioSystemMessage } from '../workunit/waiting-input.js';
import { resolveReqIdForDispatch } from '../requirements/req-binding.js';
import { OWNERSHIP_WAITING_QUESTION, resolveWorkspaceForWU } from '../requirements/ownership-resolver.js';

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
 * F6 → B3a 工程归属链（决策 D2）：创建 WorkUnit 时解析工程归属 —
 * 显式 workspaceId > Requirement.projectId → PMO 项目 gitRepo（metadata.workspaceRoot
 * 落档，agent-loop 直接作为执行根目录）> 频道 defaultWorkspaceId（降级为默认提示）
 * > 无归属：WU 照常创建但立即 NEED_INPUT 挂起（blocked + waitingForInput，
 * waitingReason='ownership'），并向频道发 Studio 系统消息问人；
 * 线程回复经 waiting-input 解析绑定工程后复活。
 *
 * REQ 需求编号（vision §5.3）：@mention 派发时绑定需求 —
 * options.reqId 显式指定 > 消息文本 #REQ-XXXX token > 自动新建（best-effort）。
 *
 * P0 修复 6：options.traceId 链路追踪 id — 仅 @mention 建 WU 时写入 metadata.traceId；
 * 线程回复不建 WU，不动。
 */
export async function routeMessage(
  channelId: string,
  content: string,
  replyToId?: string,
  fs?: FileStore,
  options?: { workspaceId?: string | null; reqId?: string | null; traceId?: string | null },
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
    const channel = await resolvedFs.getChannel(channelId);
    // §9.5: mention 匹配以 channel.members 为界 — 只能 @ 到本频道成员（修越界 bug）。
    // members 为空（历史频道未回填）时回退到全量 active profile 匹配，保持既有行为。
    const memberIds = parseChannels(channel?.members);
    const agent = allProfiles.find(p =>
      p.name === mentionName && (memberIds.length === 0 || memberIds.includes(p.id))
    ) ?? null;
    const scope = content.replace(/@[\p{L}\p{N}_-]+\s*/u, '');
    const skillHints = parseSkillHints(content);
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
    // B3a 工程归属链（决策 D2）：显式 > Requirement→PMO gitRepo > 频道默认 > 无归属挂起。
    // 解析故障返回 null，走旧绑定规则兜底。
    const ownership = await resolveWorkspaceForWU({
      explicitWorkspaceId: options?.workspaceId,
      reqId,
      channelId,
      fileStore: resolvedFs,
    }).catch(err => {
      logger.warn('[MessageRouting] Ownership resolution failed, falling back to legacy workspace binding', {
        error: String(err),
      });
      return null;
    });
    // ownership 非 null 时其字段为权威解析结果（source=requirement/none 的 null 不再回落）；
    // 仅解析故障（null）回退旧绑定规则（不挂起，保可用性）。
    const workspaceId = ownership ? ownership.workspaceId : (options?.workspaceId ?? channel?.defaultWorkspaceId ?? null);
    const parked = ownership?.source === 'none';
    const workUnit = await wuService.create({
      scope,
      channelId,
      type: 'task',
      // B3a: 无归属 → 立即 NEED_INPUT 挂起（blocked），等人回复工程名/路径
      status: parked ? 'blocked' : 'unassigned',
      assigneeId: agent?.id ?? null,
      workspaceId,
      reqId,
      metadata: {
        mentionName,
        matched: !!agent,
        creationMode: 'mention',
        // P0 修复 6: traceId 贯穿（audit requestId → WU metadata → agent-loop 日志）
        ...(options?.traceId ? { traceId: options.traceId } : {}),
        // §10.3: +skill名 显式指定（token 保留在原文中，仅解析进 metadata）
        ...(skillHints.length > 0 ? { skillHints } : {}),
        // B3a: 归属解析结果落档（来源区分供日志/审计）
        ownershipSource: ownership?.source ?? 'fallback',
        ...(ownership?.workspaceRoot ? { workspaceRoot: ownership.workspaceRoot } : {}),
        ...(ownership?.projectId ? { ownershipProjectId: ownership.projectId } : {}),
        ...(parked
          ? {
              waitingForInput: true,
              waitingQuestion: OWNERSHIP_WAITING_QUESTION,
              waitingSince: new Date().toISOString(),
              waitingReason: 'ownership',
            }
          : {}),
      },
    });
    logger.info('[MessageRouting] WorkUnit created from @mention', {
      channelId,
      workUnitId: workUnit.id,
      mentionName,
      matched: !!agent,
      workspaceId,
      reqId,
      ownershipSource: ownership?.source ?? 'fallback',
      parked,
      traceId: options?.traceId ?? undefined,
    });
    const message = await channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
    );
    // B3a: 无归属挂起 → 频道发 Studio 系统消息提问（挂在派发消息线程，回复即触发解析）
    if (parked) {
      await postStudioSystemMessage(
        resolvedFs,
        channelId,
        `任务「${scope.slice(0, 50)}」正在等待你的回复：${OWNERSHIP_WAITING_QUESTION}`,
        { replyToId: message.id, workUnitId: workUnit.id },
      ).catch(err =>
        logger.warn('[MessageRouting] Post ownership question failed (non-blocking)', {
          workUnitId: workUnit.id,
          error: String(err),
        })
      );
    }
    return message;
  }

  // Priority 3: Plain storage
  return channelMessageService.createHumanMessage(channelId, content);
}
