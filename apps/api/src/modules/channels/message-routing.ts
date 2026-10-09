/**
 * Message routing logic for channel messages (AC-B1-B4).
 *
 * Priority（#632：决策12 默认角色退役，4 环变 3 环）:
 * 1. replyToId present → thread reply (inherit workUnitId from parent)
 * 2. @mention detected → create WorkUnit
 * 3. 无 @ 无 replyTo → 合并窗口判定（#632 解耦：不再依赖频道配置，
 *    窗口内唯一在途 WU → 并入其线程；歧义（≥2 个在途 WU）/ 无目标 → 纯存储）；
 *    显式 intent 覆盖：'new-task' 建未指派 WU（涌现认领）/ 'plain' 纯存储
 *
 * 决策 11: 路由层不认识 skill——`+skill名` token 保留在 scope 原文，
 * 由 agent-loop step 时经 parseSkillHintsFromScope 解析（skill-selector.ts）。
 */
import { logger, FileStore, type ChannelData } from '@dommaker/studio-shared';
import { channelMessageService, type MessageMeta, type MessageRecord } from './channel-message.service.js';
import { WorkUnitService } from '../workunit/index.js';
import { resumeWaitingWorkUnit } from '../workunit/index.js';
import { resolveMergeTarget } from './merge-target.js';
import { detectMention } from './mention-match.js';
import { dispatchMentionMessage, dispatchNewTaskMessage } from './wu-dispatch.js';
import {
  validateFileRefs,
  type FileRef,
  type FileRefDrop,
  type FileRefVocabularyDeps,
} from './file-ref-vocabulary.js';
import { writeStudioEvent } from '@dommaker/studio-shared';
import { recordAgentDecision } from '../audit-logs/index.js';
import { getStore } from '../../core/store.js';

/**
 * #534：派发上下文袋——routeMessage 的第 4 参（原 fs? + options? 两参合并为单一 ctx?）。
 */
export interface DispatchContext {
  fs?: FileStore;
  reqId?: string | null;
  traceId?: string | null;
  /** #281: @文件引用（composer 弹框选中的结构化引用） */
  files?: FileRef[];
  /** #281: 词表/候选集依赖注入（测试用；缺省走真实数据源） */
  fileRefDeps?: FileRefVocabularyDeps;
  /**
   * #525 P2-2（决策 #517 项 3）：调用方已读出的频道记录（路由层 404 判定时已 getChannel）。
   * 传入时 mention 路径（含归属解析的频道 defaultPath 读取）不再重复 getChannel；
   * 未传入保持现状读。
   */
  channel?: ChannelData | null;
  /**
   * #632：发送前归属预览的显式意图覆盖（仅作用于无 @ 无 replyTo 路径）——
   * 'new-task' = 用户选择「新任务」（建未指派 WU 走涌现认领）；
   * 'plain' = 用户选择「纯消息」（跳过合并判定直接纯存储）；
   * 缺省 = 自动合并判定（resolveMergeTarget）。
   */
  intent?: 'new-task' | 'plain';
}

/**
 * Route a message based on its content and context.
 *
 * Priority order:
 * 1. replyToId → thread reply: inherit workUnitId from parent message
 * 2. @mention → create WorkUnit, associate with message
 * 3. 无 @ 无 replyTo（#632 决策12 退役后）：
 *    intent='new-task' → 建未指派 WU（creationMode='channel-new-task'，涌现认领）；
 *    intent='plain' → 纯存储；
 *    缺省 → 合并窗口判定（resolveMergeTarget）：唯一在途 WU 并入其线程，
 *    歧义/无目标 → 纯存储（不再有任何自动建单路径）
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
 * ctx.reqId 显式指定 > 消息文本 #REQ-XXXX token > 自动新建（best-effort）。
 *
 * P0 修复 6 + #519：ctx.traceId 链路追踪 id — 三条派单路径统一写入：
 * @mention / intent=new-task 新建 WU 时写入 metadata.traceId；线程回复与合并窗口
 * 关联到既有 WU 时，把该 WU 的 metadata.traceId 刷新为本次请求值（#519 口径：
 * spec user story 5 二选一，统一取「本次消息 traceId」，与 AC「与本次请求一致」对齐）。
 *
 * #281（决策 #249 §2/§3 + #257 D7/D9）：ctx.files @文件引用 —— 路由时存在性校验
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
  ctx?: DispatchContext,
) {
  const resolvedFs = ctx?.fs ?? getStore();
  // Use resolved FileStore for WorkUnitService (supports test injection)
  const wuService = new WorkUnitService(resolvedFs);

  // #281: 文件引用校验（候选集是 UX 划界非安全边界；校验自身故障不阻断消息，按无引用处理——
  // 但不静默吞掉：整批引用以 reason=validation-failed 计入 droppedRefs，
  // 与正常剔除同等可见（频道系统播报 + file_refs_dropped 事件））
  let filesMeta: MessageMeta | undefined;
  let droppedRefs: FileRefDrop[] = [];
  if (ctx?.files?.length) {
    try {
      const validation = await validateFileRefs(channelId, ctx.files, {
        fileStore: resolvedFs,
        ...ctx.fileRefDeps,
      });
      if (validation.kept.length > 0) filesMeta = { files: validation.kept };
      droppedRefs = validation.dropped;
    } catch (err) {
      logger.warn('[MessageRouting] File-ref validation failed, proceeding without refs', {
        channelId, error: String(err),
      });
      droppedRefs = ctx.files.map(f => ({
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
    if (!ctx?.traceId) return;
    await resolvedFs.updateMetadata(workUnitId, latest => ({
      ...latest,
      traceId: ctx.traceId,
    })).catch(err =>
      logger.warn('[MessageRouting] Refresh WorkUnit traceId failed (non-blocking)', {
        workUnitId, traceId: ctx.traceId, error: String(err),
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
    // F5: 回复对象是挂起中的 WorkUnit → 解除挂起并把回复注入下一轮 prompt（best-effort）。
    // B2：traceId 传入折进 resume 的同一次锁内写（消费分支不再独立 refresh 一次全量
    // index R/W）；未消费（非 blocked/active、等待中未识别回复等）→ 回退独立 refresh（口径同前）
    if (inheritedWorkUnitId) {
      const consumed = await resumeWaitingWorkUnit(inheritedWorkUnitId, content, resolvedFs, {
        traceId: ctx?.traceId,
      }).catch(err => {
        logger.warn('[MessageRouting] Resume waiting WorkUnit failed (non-blocking)', {
          workUnitId: inheritedWorkUnitId,
          error: String(err),
        });
        return false;
      });
      // #519: 线程回复关联的 WU 同样携带本次 traceId（全链路统一关联键）
      if (!consumed) await refreshWuTraceId(inheritedWorkUnitId);
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

  // Priority 2: @mention → create WorkUnit（建单路径已收口 wu-dispatch.ts）
  const mentionName = detectMention(content);
  if (mentionName) {
    return dispatchMentionMessage(channelId, content, mentionName, {
      reqId: ctx?.reqId,
      traceId: ctx?.traceId,
      channel: ctx?.channel,
    }, { fs: resolvedFs, wuService, filesMeta, reportDroppedRefs });
  }

  // Priority 3（#632，决策12 默认角色退役后）：无 @ 无 replyTo 消息归宿。
  // fail-closed 总原则：拿不准就不动——显式 intent 优先，缺省走合并窗口判定，
  // 歧义（窗口内 ≥2 个不同在途 WU）/ 无目标一律纯存储，不再有任何自动建单路径。
  if (ctx?.intent === 'new-task') {
    // 发送前归属预览的「新任务」选择：建未指派 WU 走涌现认领（与 mention 并列的显式建单，
    // 同收口 wu-dispatch.ts；#494 先落派发消息再建 WU 骨架共享）
    return dispatchNewTaskMessage(channelId, content, { traceId: ctx?.traceId }, {
      fs: resolvedFs, wuService, filesMeta, reportDroppedRefs,
    });
  }

  if (ctx?.intent !== 'plain') {
    // 缺省自动判定（#632 解耦：不再依赖任何频道配置）——窗口内唯一在途 WU → 并入其线程
    const resolution = await resolveMergeTarget(channelId, resolvedFs, wuService);
    if (resolution.kind === 'unique') {
      const mergeTarget = resolution.target;
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
      // B2：traceId 传入折进 resume 的同一次锁内写（消费分支不再独立 refresh）；
      // 未消费分支的 pendingReplies 追加 + traceId 刷新并成同一次 updateMetadata
      const consumed = await resumeWaitingWorkUnit(mergeTarget.id, content, resolvedFs, {
        traceId: ctx?.traceId,
      }).catch(err => {
        logger.warn('[MessageRouting] Resume merge-target WorkUnit failed (non-blocking)', {
          workUnitId: mergeTarget.id, error: String(err),
        });
        return false;
      });
      if (!consumed) {
        await resolvedFs.updateMetadata(mergeTarget.id, latest => ({
          ...latest,
          pendingReplies: [...(Array.isArray(latest.pendingReplies) ? latest.pendingReplies : []), content],
          // #519: 合并窗口并入的在途 WU 刷新为本次消息 traceId（与线程回复同口径）
          ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
        })).catch(err =>
          logger.warn('[MessageRouting] Append pendingReplies for merge target failed (non-blocking)', {
            workUnitId: mergeTarget.id, error: String(err),
          })
        );
      }
      // 已消费时 traceId 已折进 resume 的锁内写，无需独立 refreshWuTraceId
      logger.info('[MessageRouting] Message merged into in-flight WorkUnit (merge window)', {
        channelId,
        workUnitId: mergeTarget.id,
      });
      // #591：合并窗口并入决策埋点（词表 dispatch，via=merge；对象 = 在途 WU，无指名 actor）
      recordAgentDecision({
        action: 'dispatch',
        resource: 'workunit',
        resourceId: mergeTarget.id,
        details: { via: 'merge', channelId },
        requestId: ctx?.traceId ?? undefined,
      });
      await reportDroppedRefs(message);
      return message;
    }
    // ambiguous（歧义守卫）/ none → 落下方纯存储
  }

  // 纯存储
  const message = await channelMessageService.createHumanMessage(channelId, content, undefined, undefined, filesMeta);
  await reportDroppedRefs(message);
  return message;
}
