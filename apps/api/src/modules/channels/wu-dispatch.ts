/**
 * WU 建单派发路径（自 message-routing.ts 拆出，#688）——routeMessage 的三环优先级中
 * 两条「新建 WorkUnit」路径：
 *
 * - dispatchMentionMessage：@mention 派单（成员界匹配 → 归属解析 → 建单 → 埋点 →
 *   挂起提问/未匹配提示）
 * - dispatchNewTaskMessage：#632 显式 intent='new-task' 建未指派 WU（涌现认领）
 *
 * 两路径共享 #494 骨架（本文件私有助手）：先落派发消息再建 WU——
 * WU metadata.anchorMessageId 显式携带派发消息 id（认领播报优先锚它，消 created
 * 事件先于派发消息落库的 findAnchorMessage 竞态）；建单后 linkWorkUnit 回填
 * 消息 ↔ WU 关联（best-effort，同 createFromMessage 既有路径）。
 */
import { logger, type ChannelData, type FileStore } from '@dommaker/studio-shared';
import { getChannelMessageService, type MessageMeta, type MessageRecord } from './channel-message.service.js';
import { WorkUnitService, postWuSystemMessage, type WorkUnitData } from '../workunit/index.js';
import { matchMentionAgent, stripMentionScope } from './mention-match.js';
import { resolveReqIdForDispatch, OWNERSHIP_WAITING_QUESTION, resolveWorkspaceForWU } from '../requirements/index.js';
import { STUDIO_ROLE_NAME } from '../../core/system-role.js';
import { recordAgentDecision } from '../audit-logs/index.js';

type CreateWuInput = Parameters<WorkUnitService['create']>[0];

/** 两路径共享的调用侧依赖袋（fs/wuService 由 routeMessage 解析注入；filesMeta/reportDroppedRefs 来自 #281 文件引用校验段）。 */
export interface WuDispatchDeps {
  fs: FileStore;
  wuService: WorkUnitService;
  filesMeta?: MessageMeta;
  reportDroppedRefs: (message: MessageRecord) => Promise<void>;
}

export interface MentionDispatchOptions {
  reqId?: string | null;
  traceId?: string | null;
  /**
   * #525 P2-2（决策 #517 项 3）：调用方已读出的频道记录（路由层 404 判定时已 getChannel）。
   * 传入时 mention 路径（含归属解析的频道 defaultPath 读取）不再重复 getChannel；
   * 未传入（undefined）保持现状读。
   */
  channel?: ChannelData | null;
}

export interface NewTaskDispatchOptions {
  traceId?: string | null;
}

/**
 * #494（方案 c，票内预授权）共享骨架上半：先落派发消息再建 WU，
 * metadata.anchorMessageId 显式合并派发消息 id。
 */
async function createDispatchedWorkUnit(
  channelId: string,
  content: string,
  input: CreateWuInput,
  deps: WuDispatchDeps,
): Promise<{ dispatchMessage: MessageRecord; workUnit: WorkUnitData }> {
  const dispatchMessage = await getChannelMessageService().createHumanMessage(
    channelId,
    content,
    undefined,
    undefined,
    deps.filesMeta,
  );
  const workUnit = await deps.wuService.create({
    ...input,
    channelId,
    type: 'task',
    metadata: {
      ...input.metadata,
      // #494: 认领播报的显式线程锚点（见文件头时序说明）
      anchorMessageId: dispatchMessage.id,
    },
  });
  return { dispatchMessage, workUnit };
}

/**
 * #494 共享骨架下半：linkWorkUnit 回填派发消息 ↔ WU 关联（best-effort：失败仅缺
 * back-link，线程锚定已由 anchorMessageId 承载；返回值替换派发消息记录，保持
 * routeMessage 返回值的 workUnitId 契约不变）+ #281 剔除面播报。
 */
async function linkDispatchMessage(
  channelId: string,
  dispatchMessage: MessageRecord,
  workUnit: WorkUnitData,
  deps: WuDispatchDeps,
): Promise<MessageRecord> {
  const message = await getChannelMessageService().linkWorkUnit(dispatchMessage.id, workUnit.id, channelId).catch(err => {
    logger.warn('[MessageRouting] Link dispatch message to WorkUnit failed (non-blocking)', {
      workUnitId: workUnit.id, messageId: dispatchMessage.id, error: String(err),
    });
    return dispatchMessage;
  });
  await deps.reportDroppedRefs(message);
  return message;
}

/**
 * @mention 派单：成员界匹配（mention-match.ts）→ REQ 绑定 → B3a 归属解析 → 建 WU →
 * 埋点 → 回填 → （无归属挂起提问 / 未匹配提示）。
 *
 * F6 → B3a 工程归属链（决策 D2）：Requirement.projectId → PMO 项目 gitRepo / 文件引用 /
 * 频道 defaultPath（metadata.workspaceRoot 落档，agent-loop 直接作为执行根目录）；
 * 无归属：WU 照常创建但立即 NEED_INPUT 挂起（blocked + waitingForInput，
 * waitingReason='ownership'），并向频道发 Studio 系统消息问人。
 * #481：显式/频道默认的 workspaceId（机器指针）两级已退役，不再参与归属。
 *
 * REQ 需求编号（vision §5.3）：ctx.reqId 显式指定 > 消息文本 #REQ-XXXX token >
 * 自动新建（best-effort：绑定失败不阻断 WorkUnit 创建）。
 */
export async function dispatchMentionMessage(
  channelId: string,
  content: string,
  mentionName: string,
  opts: MentionDispatchOptions,
  deps: WuDispatchDeps,
): Promise<MessageRecord> {
  const { fs, filesMeta } = deps;
  // B2：profile 列表 / 频道记录 / REQ 绑定三者互不依赖（REQ 绑定不依赖 profile
  // 匹配结果，也不读 channel 记录），并行发出；归属解析依赖 reqId + channel 仍在其后。
  const [allProfiles, channel, reqId] = await Promise.all([
    fs.listProfiles({ status: 'active' }),
    opts.channel !== undefined ? Promise.resolve(opts.channel) : fs.getChannel(channelId),
    // REQ 需求编号（vision §5.3）：显式 > #REQ-XXXX token > 自动新建。
    // best-effort：绑定失败不阻断 WorkUnit 创建（log + 不带 reqId 继续）。
    resolveReqIdForDispatch({
      explicitReqId: opts.reqId,
      content,
      channelId,
      createdBy: 'mention',
      fileStore: fs,
    }).catch(err => {
      logger.warn('[MessageRouting] REQ binding failed (non-blocking)', { error: String(err) });
      return null;
    }),
  ]);
  // mention 匹配（§9.5 成员界 / #632 系统角色不参与 / #496 中文连写最长前缀兜底）
  // 与 scope 剥离口径均已收口 mention-match.ts 纯函数。
  const { agent, prefixMatchName } = matchMentionAgent(allProfiles, mentionName, channel);
  // #632：F5 @studio 转派分支（转派目标 = 频道 defaultProfileId 入口角色）已随
  // defaultProfileId 退役删除——@studio 按未匹配 mention 走既有「转自动认领」提示。
  const scope = stripMentionScope(content, prefixMatchName);
  // B3a 工程归属链（决策 D2 + #285 决策 #249 §4）：Requirement→PMO gitRepo
  // > 文件引用（kept refs 全同仓）> 频道默认工程 > 无归属挂起。
  // 解析故障返回 null：按无归属继续但不挂起（保可用性，与退役前一致）。
  const ownership = await resolveWorkspaceForWU({
    reqId,
    channelId,
    fileRefs: filesMeta?.files,
    fileStore: fs,
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
  const { dispatchMessage, workUnit } = await createDispatchedWorkUnit(channelId, content, {
    scope,
    // B3a: 无归属 → 立即 NEED_INPUT 挂起（blocked），等人回复工程名/路径
    status: parked ? 'blocked' : 'unassigned',
    assigneeId: agent?.id ?? undefined,
    reqId,
    metadata: {
      // #496: 前缀兜底命中时落解析后的成员名（展示/认领播报以角色正名为准）
      mentionName: prefixMatchName ?? mentionName,
      matched: !!agent,
      creationMode: 'mention',
      // P0 修复 6: traceId 贯穿（audit requestId → WU metadata → agent-loop 日志）
      ...(opts.traceId ? { traceId: opts.traceId } : {}),
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
  }, deps);
  logger.info('[MessageRouting] WorkUnit created from @mention', {
    channelId,
    workUnitId: workUnit.id,
    mentionName,
    matched: !!agent,
    reqId,
    ownershipSource: ownership?.source ?? 'fallback',
    parked,
    traceId: opts.traceId ?? undefined,
  });
  // #591：@mention 派单决策埋点（词表 dispatch；依据 = 匹配方式摘要，不落消息全文）
  recordAgentDecision({
    action: 'dispatch',
    resource: 'workunit',
    resourceId: workUnit.id,
    actor: agent ? { id: agent.id, type: 'agent' } : undefined,
    details: {
      via: 'mention',
      channelId,
      mentionName: prefixMatchName ?? mentionName,
      matched: !!agent,
      ...(prefixMatchName ? { prefixFallback: true } : {}),
      ...(parked ? { parked: true } : {}),
    },
    requestId: opts.traceId ?? undefined,
  });
  const message = await linkDispatchMessage(channelId, dispatchMessage, workUnit, deps);
  // B3a: 无归属挂起 → 频道发 Studio 系统消息提问（挂在派发消息线程，回复即触发解析）
  // #464：milestone=true（atHuman 响铃 + 行动中心通知双写）——挂起提问是「需要人答」，
  // 此前只上屏不响铃，非在线人看不到（票体补充评论并入项）。
  if (parked) {
    await postWuSystemMessage(
      workUnit,
      `任务「${scope.slice(0, 50)}」正在等待你的回复：${OWNERSHIP_WAITING_QUESTION}`,
      { replyToId: message.id, fileStore: fs, milestone: true },
    ).catch(err =>
      logger.warn('[MessageRouting] Post ownership question failed (non-blocking)', {
        workUnitId: workUnit.id,
        error: String(err),
      })
    );
  }
  // #464: @mention 未匹配（角色不存在/非本频道成员/系统角色）→ 线程说明。
  // 此前 WU 照建、matched=false 落档但频道零提示，用户以为已派给某人。
  if (!agent) {
    const unmatchedText = mentionName === STUDIO_ROLE_NAME
      ? 'studio 是系统角色，不执行任务，本单已转自动认领（频道成员可认领）'
      : `未找到角色 @${mentionName}（不存在或非本频道成员），本单已转自动认领（频道成员可认领）`;
    await postWuSystemMessage(workUnit, unmatchedText, {
      replyToId: message.id, fileStore: fs,
    }).catch(err =>
      logger.warn('[MessageRouting] Post unmatched-mention notice failed (non-blocking)', {
        workUnitId: workUnit.id,
        error: String(err),
      })
    );
  }
  return message;
}

/**
 * #632 显式 intent='new-task'：发送前归属预览的「新任务」选择——建未指派 WU 走
 * 涌现认领（与 mention 并列的显式建单；本路径不做归属解析，文件引用仅落档供
 * prompt-composer files 段消费）。
 */
export async function dispatchNewTaskMessage(
  channelId: string,
  content: string,
  opts: NewTaskDispatchOptions,
  deps: WuDispatchDeps,
): Promise<MessageRecord> {
  const { dispatchMessage, workUnit } = await createDispatchedWorkUnit(channelId, content, {
    scope: content,
    status: 'unassigned',
    assigneeId: undefined, // 涌现认领（agent-loop observe 未指派过滤）
    metadata: {
      creationMode: 'channel-new-task',
      // #519: traceId 贯穿（与 @mention 路径同写法）
      ...(opts.traceId ? { traceId: opts.traceId } : {}),
      // #285: @文件引用落档（本路径不做归属解析，仅落档供 prompt-composer files 段消费）
      ...(deps.filesMeta?.files ? { fileRefs: deps.filesMeta.files } : {}),
    },
  }, deps);
  logger.info('[MessageRouting] WorkUnit created by explicit new-task intent', {
    channelId,
    workUnitId: workUnit.id,
  });
  // #591：显式建单埋点（词表 dispatch，via=new-task；未指派无 actor）
  recordAgentDecision({
    action: 'dispatch',
    resource: 'workunit',
    resourceId: workUnit.id,
    details: { via: 'new-task', channelId },
    requestId: opts.traceId ?? undefined,
  });
  return linkDispatchMessage(channelId, dispatchMessage, workUnit, deps);
}
