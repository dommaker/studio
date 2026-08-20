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
import { channelMessageService, type MessageMeta, type MessageRecord } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { resumeWaitingWorkUnit } from '../workunit/waiting-input.js';
import { postWuSystemMessage } from '../workunit/wu-messenger.js';
import { resolveReqIdForDispatch } from '../requirements/req-binding.js';
import { OWNERSHIP_WAITING_QUESTION, resolveWorkspaceForWU } from '../requirements/ownership-resolver.js';
import { STUDIO_ROLE_NAME } from '../agents/agent-profile.service.js';
import {
  validateFileRefs,
  type FileRef,
  type FileRefDrop,
  type FileRefVocabularyDeps,
} from './file-ref-vocabulary.js';
import { writeStudioEvent } from '../../utils/studio-events.js';

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
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. 决策 12: 频道配置了 defaultProfileId → 无 @ 消息派给默认角色建 WorkUnit
 * 4. plain text → store without workUnitId（未配置默认角色 = 维持纯存储）
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
 *
 * #281（决策 #249 §2/§3 + #257 D7/D9）：options.files @文件引用 —— 路由时存在性校验
 * （repo ∈ 频道相关工程候选集 且 path ∈ 该仓 git ls-files 词表）；有效引用写消息
 * 结构化 meta.files（mention 仍为纯文本不动），失效引用剔除（不进消息 meta、不进 WU）
 * + 频道 Studio 系统播报 + channel:file_refs_dropped 事件（reason + paths，
 * dropped 封顶前 5 条 + droppedCount 全量）。校验自身故障（异常路径）同样不静默：
 * 整批引用按 reason=validation-failed 走同一播报/事件面，消息按无引用继续。
 */
export async function routeMessage(
  channelId: string,
  content: string,
  replyToId?: string,
  fs?: FileStore,
  options?: {
    workspaceId?: string | null;
    reqId?: string | null;
    traceId?: string | null;
    /** #281: @文件引用（composer 弹框选中的结构化引用） */
    files?: FileRef[];
    /** #281: 词表/候选集依赖注入（测试用；缺省走真实数据源） */
    fileRefDeps?: FileRefVocabularyDeps;
  },
) {
  const resolvedFs = fs ?? fileStore;
  // Use resolved FileStore for WorkUnitService (supports test injection)
  const wuService = new WorkUnitService(resolvedFs);

  // #281: 文件引用校验（候选集是 UX 划界非安全边界；校验自身故障不阻断消息，按无引用处理——
  // 但不静默吞掉：整批引用以 reason=validation-failed 计入 droppedRefs，
  // 与正常剔除同等可见（频道系统播报 + file_refs_dropped 事件））
  let filesMeta: MessageMeta | undefined;
  let droppedRefs: FileRefDrop[] = [];
  if (options?.files?.length) {
    try {
      const validation = await validateFileRefs(channelId, options.files, {
        fileStore: resolvedFs,
        ...options.fileRefDeps,
      });
      if (validation.kept.length > 0) filesMeta = { files: validation.kept };
      droppedRefs = validation.dropped;
    } catch (err) {
      logger.warn('[MessageRouting] File-ref validation failed, proceeding without refs', {
        channelId, error: String(err),
      });
      droppedRefs = options.files.map(f => ({
        repo: typeof f?.repo === 'string' ? f.repo : '',
        path: typeof f?.path === 'string' ? f.path : '',
        reason: 'validation-failed',
      }));
    }
  }
  // 剔除面：频道系统播报 + file_refs_dropped 事件（best-effort 播报，事件 await 落盘）
  const reportDroppedRefs = async (message: MessageRecord) => {
    if (droppedRefs.length === 0) return;
    const REASON_LABEL: Record<FileRefDrop['reason'], string> = {
      'not-found': '不存在',
      'not-in-candidate-set': '不在本频道候选工程内',
      'validation-failed': '校验失败',
    };
    const listed = droppedRefs.slice(0, 5)
      .map(d => `${d.path}（${REASON_LABEL[d.reason]}）`).join('、');
    const suffix = droppedRefs.length > 5 ? ` 等 ${droppedRefs.length} 条` : '';
    await channelMessageService.createAgentMessage(
      channelId,
      'Studio',
      `部分文件引用已失效，未随消息发出：${listed}${suffix}`,
      { replyToId: message.id },
    ).catch(err =>
      logger.warn('[MessageRouting] Post file-refs-dropped notice failed (non-blocking)', {
        channelId, error: String(err),
      })
    );
    await writeStudioEvent('channel:file_refs_dropped', {
      channelId,
      messageId: message.id,
      droppedCount: droppedRefs.length,
      dropped: droppedRefs.slice(0, 5),
    }, { source: 'message-routing' });
  };

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
      filesMeta,
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
    await reportDroppedRefs(message);
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
    const inScope = (p: (typeof allProfiles)[number]) => memberIds.length === 0 || memberIds.includes(p.id);
    let agent = allProfiles.find(p => p.name === mentionName && inScope(p)) ?? null;
    // F5（2026-07-28 分析文档决策 6）: @studio 特殊路由 — studio 是系统角色不执行任务；
    // 转派目标 = 频道 defaultProfileId 入口角色（与决策 12 同字段），未配置/inactive/越界
    // → 未指派（assigneeId=null），走 claim 涌现（agent-loop observe 未指派过滤）。
    // 转派成功：metadata.reroutedFrom='studio' + 频道发 Studio 系统消息说明。
    let reroutedFrom: string | undefined;
    let reroutedToName: string | undefined;
    if (mentionName === STUDIO_ROLE_NAME) {
      const entry = channel?.defaultProfileId
        ? allProfiles.find(p => p.id === channel.defaultProfileId && inScope(p)) ?? null
        : null;
      agent = entry;
      if (entry) {
        reroutedFrom = STUDIO_ROLE_NAME;
        reroutedToName = entry.name;
      }
    }
    const scope = content.replace(/@[\p{L}\p{N}_-]+\s*/u, '');
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
    // B3a 工程归属链（决策 D2 + #285 决策 #249 §4）：显式 > Requirement→PMO gitRepo
    // > 文件引用（kept refs 全同仓）> 频道默认 > 无归属挂起。
    // 解析故障返回 null，走旧绑定规则兜底。
    const ownership = await resolveWorkspaceForWU({
      explicitWorkspaceId: options?.workspaceId,
      reqId,
      channelId,
      fileRefs: filesMeta?.files,
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
        // B4a: @studio 改派标记（WU 实际派给 pm，非 studio 本身）
        ...(reroutedFrom ? { reroutedFrom } : {}),
        // P0 修复 6: traceId 贯穿（audit requestId → WU metadata → agent-loop 日志）
        ...(options?.traceId ? { traceId: options.traceId } : {}),
        // #285: @文件引用落档（仅在有有效引用时写字段；prompt-composer files 段消费）
        ...(filesMeta?.files ? { fileRefs: filesMeta.files } : {}),
        // B3a: 归属解析结果落档（来源区分供日志/审计）
        ownershipSource: ownership?.source ?? 'fallback',
        ...(ownership?.workspaceRoot ? { workspaceRoot: ownership.workspaceRoot } : {}),
        // 2026-08 归因统一：创建期 PMO 归因戳 canonical key = pmoId（legacy 名 ownershipProjectId 废弃，
        // 读取侧同级兼容，见 requirements/wu-pmo-attribution.ts）
        ...(ownership?.projectId ? { pmoId: ownership.projectId } : {}),
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
      reroutedFrom,
      traceId: options?.traceId ?? undefined,
    });
    const message = await channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
      filesMeta,
    );
    await reportDroppedRefs(message);
    // F5: @studio 改派 → 频道发 Studio 系统消息说明（best-effort，挂在派发消息线程）
    if (reroutedFrom) {
      await postWuSystemMessage(
        workUnit,
        `studio 是系统角色，你的消息已转给 @${reroutedToName}`,
        { replyToId: message.id, fileStore: resolvedFs },
      ).catch(err =>
        logger.warn('[MessageRouting] Post studio-reroute notice failed (non-blocking)', {
          workUnitId: workUnit.id,
          error: String(err),
        })
      );
    }
    // B3a: 无归属挂起 → 频道发 Studio 系统消息提问（挂在派发消息线程，回复即触发解析）
    if (parked) {
      await postWuSystemMessage(
        workUnit,
        `任务「${scope.slice(0, 50)}」正在等待你的回复：${OWNERSHIP_WAITING_QUESTION}`,
        { replyToId: message.id, fileStore: resolvedFs },
      ).catch(err =>
        logger.warn('[MessageRouting] Post ownership question failed (non-blocking)', {
          workUnitId: workUnit.id,
          error: String(err),
        })
      );
    }
    return message;
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
      metadata: {
        creationMode: 'channel-default',
        // #285: @文件引用落档（本路径不做归属解析，仅落档供 prompt-composer files 段消费）
        ...(filesMeta?.files ? { fileRefs: filesMeta.files } : {}),
      },
    });
    logger.info('[MessageRouting] WorkUnit created for channel default profile', {
      channelId,
      workUnitId: workUnit.id,
      defaultProfileId: channel.defaultProfileId,
    });
    const message = await channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      workUnit.id,
      filesMeta,
    );
    await reportDroppedRefs(message);
    return message;
  }

  // Priority 4: Plain storage
  const message = await channelMessageService.createHumanMessage(channelId, content, undefined, undefined, filesMeta);
  await reportDroppedRefs(message);
  return message;
}
