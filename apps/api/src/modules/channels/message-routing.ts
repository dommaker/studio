/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. 决策 12: 频道配置了 defaultProfileId → 无 @ 消息派给默认角色建 WorkUnit
 *    （#495：合并窗口内并入在途 WU 线程，不新建）
 * 4. plain text → store only
 *
 * 决策 11: 路由层不认识 skill——`+skill名` token 保留在 scope 原文，
 * 由 agent-loop step 时经 parseSkillHintsFromScope 解析（skill-selector.ts）。
 */
import { logger, FileStore, parseChannels, type ChannelData } from '@dommaker/studio-shared';
import { channelMessageService, type MessageMeta, type MessageRecord } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import { resumeWaitingWorkUnit } from '../workunit/waiting-input.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
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
 * #495（方案 a，票内预授权 2026-09-11）：合并窗口内在途状态——终态（done/closed）
 * 与 in_review（等人工验收）不吸收新消息，窗口内来新消息照章新建 WU。
 */
const MERGE_IN_FLIGHT_STATUSES = new Set(['pending', 'unassigned', 'active', 'blocked']);

/**
 * #495：决策 12 派单合并窗口（毫秒）。窗口内同频道连续无 @ 消息合并进在途 WU 线程
 * （继续对话 = 继续任务），替代「每条闲聊建一张 WU」。默认 5 分钟，
 * STUDIO_CHANNEL_MERGE_WINDOW_MINUTES 覆盖（仿 getReminderThresholdMs 口径）。
 */
export function getMergeWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.STUDIO_CHANNEL_MERGE_WINDOW_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000;
}

/**
 * #495：找合并目标——同频道最近一条携带 workUnitId 的人类消息（上轮派单/合并/线程回复
 * 的落点），其 createdAt 在窗口内且 WU 仍在途 → 返回该 WU；否则 null（照章新建）。
 * 锚点为消息时间而非 WU.updatedAt：每次合并落新消息即刷新窗口（滑动窗口语义）。
 * #524 P1-1（#514 定案 D 方案）：全热文件读 → 尾部倒扫收集 20 条人类消息即停
 * （去重/tombstone 口径与原 queryMessages 一致；不按 createdAt 早停——更新-append
 * 使文件序≠时间序，决议已否决时间早停）。
 */
async function findMergeTargetWorkUnit(
  channelId: string,
  fs: FileStore,
  now: Date = new Date(),
): Promise<{ id: string; anchorMessageId?: string } | null> {
  const { messages: recentHuman } = await fs.readMessagesTail(channelId, {
    limit: 20,
    match: m => m.authorType === 'human',
  });
  const last = recentHuman.find(m => m.workUnitId); // 倒扫序 = 新→旧，首条命中即最新落点
  if (!last?.workUnitId) return null;
  if (now.getTime() - new Date(last.createdAt).getTime() > getMergeWindowMs()) return null;
  const wu = await new WorkUnitService(fs).getById(last.workUnitId);
  if (!wu || wu.channelId !== channelId) return null;
  if (!MERGE_IN_FLIGHT_STATUSES.has(wu.status)) return null;
  // parseWuMetadata 容错口径：畸形 metadata 落 {}（anchorMessageId 缺省走首根回退），不抛错拖垮整道路由
  const meta = parseWuMetadata(wu.metadata);
  return {
    id: wu.id,
    anchorMessageId: typeof meta.anchorMessageId === 'string' ? meta.anchorMessageId : undefined,
  };
}

/**
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. 决策 12: 频道配置了 defaultProfileId → 无 @ 消息派给默认角色建 WorkUnit
 *    （#495：合并窗口内已有在途 WU → 并入该 WU 线程，不新建）
 * 4. plain text → store without workUnitId（未配置默认角色 = 维持纯存储）
 *
 * F6 → B3a 工程归属链（决策 D2）：创建 WorkUnit 时解析工程归属 —
 * Requirement.projectId → PMO 项目 gitRepo / 文件引用 / 频道 defaultPath
 * （metadata.workspaceRoot 落档，agent-loop 直接作为执行根目录）
 * > 无归属：WU 照常创建但立即 NEED_INPUT 挂起（blocked + waitingForInput，
 * waitingReason='ownership'），并向频道发 Studio 系统消息问人；
 * 线程回复经 waiting-input 解析绑定工程后复活。
 * #481：显式 workspaceId 与频道 defaultWorkspaceId（默认执行机器）两级已退役，
 * WU 不再落机器指针（workspaceId 字段仅历史记录展示用，无执行语义）。
 *
 * REQ 需求编号（vision §5.3）：@mention 派发时绑定需求 —
 * options.reqId 显式指定 > 消息文本 #REQ-XXXX token > 自动新建（best-effort）。
 *
 * P0 修复 6 + #519：options.traceId 链路追踪 id — 三条派单路径统一写入：
 * @mention / 默认角色新建 WU 时写入 metadata.traceId；线程回复与合并窗口
 * 关联到既有 WU 时，把该 WU 的 metadata.traceId 刷新为本次请求值（#519 口径：
 * spec user story 5 二选一，统一取「本次消息 traceId」，与 AC「与本次请求一致」对齐）。
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
    reqId?: string | null;
    traceId?: string | null;
    /** #281: @文件引用（composer 弹框选中的结构化引用） */
    files?: FileRef[];
    /** #281: 词表/候选集依赖注入（测试用；缺省走真实数据源） */
    fileRefDeps?: FileRefVocabularyDeps;
    /**
     * #525 P2-2（决策 #517 项 3）：调用方已读出的频道记录（路由层 404 判定时已 getChannel）。
     * 传入时 mention/默认角色路径（含归属解析的频道 defaultPath 读取）不再重复 getChannel；
     * 未传入保持现状读。
     */
    channel?: ChannelData | null;
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

  // #519: 关联到既有 WU 的两条路径（线程回复 / 合并窗口）共用——把 WU metadata.traceId
  // 刷新为本次请求 traceId（best-effort：失败仅缺本次关联，不阻断消息路由）
  const refreshWuTraceId = async (workUnitId: string) => {
    if (!options?.traceId) return;
    await resolvedFs.updateMetadata(workUnitId, latest => ({
      ...latest,
      traceId: options.traceId,
    })).catch(err =>
      logger.warn('[MessageRouting] Refresh WorkUnit traceId failed (non-blocking)', {
        workUnitId, traceId: options.traceId, error: String(err),
      })
    );
  };

  // Priority 1: Thread reply — inherit workUnitId from parent
  if (replyToId) {
    // #524 P1-1：父消息必在本频道（replyToId 来自本频道 UI），按频道直查不再全频道扇出
    const found = await resolvedFs.getMessageById(replyToId, channelId);
    // #327：父消息不在热层（已归档 = getMessageById 热只读不可见；与「彻底不存在」不可区分）
    // → 引用降级放行：帖子成立、replyToId 保留（前端引用预览自然缺失）、
    // workUnitId 继承失效落 null、不触发挂起复活——不整帖抛错
    // #492：降级放行后补频道 Studio 系统提示「该话题已归档」（见下方 !found 分支）
    if (!found) {
      logger.warn('[MessageRouting] Replied message not in hot tier, degrading reply (no workUnitId inheritance)', {
        channelId, replyToId,
      });
    }
    const inheritedWorkUnitId = found?.message.workUnitId ?? undefined;
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
      // #519: 线程回复关联的 WU 同样携带本次 traceId（全链路统一关联键）
      await refreshWuTraceId(inheritedWorkUnitId);
    }
    // #492（方案 a）：父消息在冷层 → 降级放行的回复不会触达任何任务，
    // 频道发 Studio 系统提示（挂在该回复线程），用户不再静默失效；提示本身 best-effort。
    if (!found) {
      await channelMessageService.createAgentMessage(
        channelId,
        'Studio',
        '该话题已归档，回复不会触达任务',
        { replyToId: message.id },
      ).catch(err =>
        logger.warn('[MessageRouting] Post cold-tier-reply notice failed (non-blocking)', {
          channelId, replyToId, error: String(err),
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
    const channel = options?.channel !== undefined ? options.channel : await resolvedFs.getChannel(channelId);
    // §9.5: mention 匹配以 channel.members 为界 — 只能 @ 到本频道成员（修越界 bug）。
    // members 为空（历史频道未回填）时回退到全量 active profile 匹配，保持既有行为。
    const memberIds = parseChannels(channel?.members);
    const inScope = (p: (typeof allProfiles)[number]) => memberIds.length === 0 || memberIds.includes(p.id);
    let agent = allProfiles.find(p => p.name === mentionName && inScope(p)) ?? null;
    // #496: 手打中文连写兜底——token 整体精确匹配失败时，对成员名做最长前缀匹配
    // （@开发你好 → 命中成员「开发」）。多成员互为前缀取最长；等长歧义（同名 profile
    // 并列最长）回退现状（未匹配 → #464 转自动认领提示）。studio 系统角色不参与前缀兜底。
    let prefixMatchName: string | null = null;
    if (!agent && mentionName !== STUDIO_ROLE_NAME) {
      const candidates = allProfiles.filter(
        p => inScope(p) && p.name !== STUDIO_ROLE_NAME && p.name.length > 0 && mentionName.startsWith(p.name),
      );
      if (candidates.length > 0) {
        const maxLen = Math.max(...candidates.map(p => p.name.length));
        const longest = candidates.filter(p => p.name.length === maxLen);
        if (longest.length === 1) {
          agent = longest[0];
          prefixMatchName = longest[0].name;
        }
      }
    }
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
    // #496: 前缀兜底命中时只剥 `@成员名`（保留连写剩余文本作为 scope，如 @开发你好 → 你好）；
    // 精确匹配/未匹配维持剥整个 @token。成员名字符集 ⊂ [\p{L}\p{N}_-]，内联进正则安全。
    const scope = prefixMatchName
      ? content.replace(new RegExp(`@${prefixMatchName}\\s*`, 'u'), '')
      : content.replace(/@[\p{L}\p{N}_-]+\s*/u, '');
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
    // B3a 工程归属链（决策 D2 + #285 决策 #249 §4）：Requirement→PMO gitRepo
    // > 文件引用（kept refs 全同仓）> 频道默认工程 > 无归属挂起。
    // #481：显式/频道默认的 workspaceId（机器指针）两级已退役，不再参与归属。
    // 解析故障返回 null：按无归属继续但不挂起（保可用性，与退役前一致）。
    const ownership = await resolveWorkspaceForWU({
      reqId,
      channelId,
      fileRefs: filesMeta?.files,
      fileStore: resolvedFs,
      // #525 P2-2：上方已解析的 channel 透传，归属解析不再重复 getChannel
      channel,
    }).catch(err => {
      logger.warn('[MessageRouting] Ownership resolution failed, continuing without attribution', {
        error: String(err),
      });
      return null;
    });
    // ownership 非 null 时其字段为权威解析结果；解析故障（null）不挂起（保可用性）。
    const parked = ownership?.source === 'none';
    // #494（方案 c，票内预授权）：先落派发消息再建 WU——WU metadata.anchorMessageId 显式携带
    // 派发消息 id（认领播报优先锚它，消 created 事件先于派发消息落库的 findAnchorMessage 竞态）；
    // 建单后 linkWorkUnit 回填消息 ↔ WU 关联（同 createFromMessage 既有路径）。
    const dispatchMessage = await channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      undefined,
      filesMeta,
    );
    const workUnit = await wuService.create({
      scope,
      channelId,
      type: 'task',
      // B3a: 无归属 → 立即 NEED_INPUT 挂起（blocked），等人回复工程名/路径
      status: parked ? 'blocked' : 'unassigned',
      assigneeId: agent?.id ?? null,
      reqId,
      metadata: {
        // #496: 前缀兜底命中时落解析后的成员名（展示/认领播报以角色正名为准）
        mentionName: prefixMatchName ?? mentionName,
        matched: !!agent,
        creationMode: 'mention',
        // #494: 认领播报的显式线程锚点（见上方时序说明）
        anchorMessageId: dispatchMessage.id,
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
      reqId,
      ownershipSource: ownership?.source ?? 'fallback',
      parked,
      reroutedFrom,
      traceId: options?.traceId ?? undefined,
    });
    // #494: 回填派发消息 ↔ WU 关联（best-effort：失败仅缺 back-link，线程锚定已由 anchorMessageId 承载）。
    // 返回值替换派发消息记录，保持 routeMessage 返回值的 workUnitId 契约不变。
    const message = await channelMessageService.linkWorkUnit(dispatchMessage.id, workUnit.id, channelId).catch(err => {
      logger.warn('[MessageRouting] Link dispatch message to WorkUnit failed (non-blocking)', {
        workUnitId: workUnit.id, messageId: dispatchMessage.id, error: String(err),
      });
      return dispatchMessage;
    });
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
    // #464：milestone=true（atHuman 响铃 + 行动中心通知双写）——挂起提问是「需要人答」，
    // 此前只上屏不响铃，非在线人看不到（票体补充评论并入项）。
    if (parked) {
      await postWuSystemMessage(
        workUnit,
        `任务「${scope.slice(0, 50)}」正在等待你的回复：${OWNERSHIP_WAITING_QUESTION}`,
        { replyToId: message.id, fileStore: resolvedFs, milestone: true },
      ).catch(err =>
        logger.warn('[MessageRouting] Post ownership question failed (non-blocking)', {
          workUnitId: workUnit.id,
          error: String(err),
        })
      );
    }
    // #464: @mention 未匹配（角色不存在/非本频道成员；@studio 未配置默认入口）→ 线程说明。
    // 此前 WU 照建、matched=false 落档但频道零提示，用户以为已派给某人（对照 @studio 改派有系统消息）。
    if (!agent) {
      const unmatchedText = mentionName === STUDIO_ROLE_NAME
        ? 'studio 是系统角色，且本频道未配置默认入口角色，本单已转自动认领（频道成员可认领）'
        : `未找到角色 @${mentionName}（不存在或非本频道成员），本单已转自动认领（频道成员可认领）`;
      await postWuSystemMessage(workUnit, unmatchedText, {
        replyToId: message.id, fileStore: resolvedFs,
      }).catch(err =>
        logger.warn('[MessageRouting] Post unmatched-mention notice failed (non-blocking)', {
          workUnitId: workUnit.id,
          error: String(err),
        })
      );
    }
    return message;
  }

  // 决策 12: 无 @ 兜底 —— 频道配置了默认角色 → 派给它建 WorkUnit（消息关联到该 WU）
  const channel = options?.channel !== undefined ? options.channel : await resolvedFs.getChannel(channelId);
  if (channel?.defaultProfileId) {
    // #495（方案 a）：合并窗口内已有在途 WU → 消息并入该 WU 线程，不再新建 WU
    // （连发闲聊不产生 WU 风暴；窗口外/终态后正常新建）。
    const mergeTarget = await findMergeTargetWorkUnit(channelId, resolvedFs);
    if (mergeTarget) {
      const message = await channelMessageService.createHumanMessage(
        channelId,
        content,
        mergeTarget.anchorMessageId, // 挂到在途 WU 的派发线程（缺 anchor 时退为根消息）
        mergeTarget.id,
        filesMeta,
      );
      // 回复注入：blocked → resumeWaitingWorkUnit 复活 + pendingReplies；
      // active 且已有 pendingReplies → 其锁内追加分支已覆盖；其余（unassigned/active 无
      // pendingReplies）此处锁内补齐，保证 loop 下一步经 prompt-composer 注入。
      const consumed = await resumeWaitingWorkUnit(mergeTarget.id, content, resolvedFs).catch(err => {
        logger.warn('[MessageRouting] Resume merge-target WorkUnit failed (non-blocking)', {
          workUnitId: mergeTarget.id, error: String(err),
        });
        return false;
      });
      if (!consumed) {
        await resolvedFs.updateMetadata(mergeTarget.id, latest => ({
          ...latest,
          pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), content],
        })).catch(err =>
          logger.warn('[MessageRouting] Append pendingReplies for merge target failed (non-blocking)', {
            workUnitId: mergeTarget.id, error: String(err),
          })
        );
      }
      // #519: 合并窗口并入的在途 WU 刷新为本次消息 traceId（与线程回复同口径）
      await refreshWuTraceId(mergeTarget.id);
      logger.info('[MessageRouting] Message merged into in-flight WorkUnit (merge window)', {
        channelId,
        workUnitId: mergeTarget.id,
      });
      await reportDroppedRefs(message);
      return message;
    }
    // #494：同 mention 路径——先落派发消息再建 WU，anchorMessageId 显式传递消认领播报竞态
    const dispatchMessage = await channelMessageService.createHumanMessage(
      channelId,
      content,
      undefined,
      undefined,
      filesMeta,
    );
    const workUnit = await wuService.create({
      scope: content,
      channelId,
      type: 'task',
      status: 'unassigned',
      assigneeId: channel.defaultProfileId,
      metadata: {
        creationMode: 'channel-default',
        // #494: 认领播报的显式线程锚点
        anchorMessageId: dispatchMessage.id,
        // #519: traceId 贯穿（与 @mention 路径同写法）
        ...(options?.traceId ? { traceId: options.traceId } : {}),
        // #285: @文件引用落档（本路径不做归属解析，仅落档供 prompt-composer files 段消费）
        ...(filesMeta?.files ? { fileRefs: filesMeta.files } : {}),
      },
    });
    logger.info('[MessageRouting] WorkUnit created for channel default profile', {
      channelId,
      workUnitId: workUnit.id,
      defaultProfileId: channel.defaultProfileId,
    });
    const message = await channelMessageService.linkWorkUnit(dispatchMessage.id, workUnit.id, channelId).catch(err => {
      logger.warn('[MessageRouting] Link dispatch message to WorkUnit failed (non-blocking)', {
        workUnitId: workUnit.id, messageId: dispatchMessage.id, error: String(err),
      });
      return dispatchMessage;
    });
    await reportDroppedRefs(message);
    return message;
  }

  // Priority 4: Plain storage
  const message = await channelMessageService.createHumanMessage(channelId, content, undefined, undefined, filesMeta);
  await reportDroppedRefs(message);
  return message;
}
