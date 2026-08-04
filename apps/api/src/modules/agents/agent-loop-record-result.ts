// AgentLoop recordResult（监控检查点 + 状态迁移 + 各守卫，零 token）——
// 从 agent-loop.ts 原样抽出，行为不变。
//
// B3b-i（决策 D3 前半）验证命令解析与执行已抽到 ./wu-verification.js（F6-c）——
// resolveVerifyCommands / runWuVerification 为模块级导出，行为不变。
import { logger, withAttestation, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../workunit/workunit.service.js';
import { checkDelegation, effectiveParentCollab, resolveMaxDepth, type CollabMeta } from '../workunit/delegation-gate.js';
import { ChannelMessageService, type MessageMeta } from '../channels/channel-message.service.js';
import { resolvePmoProjectIdForWU } from '../requirements/pmo-branch-resolver.js';
import { CODE_WORKTREE_TYPES, runWuVerification } from './wu-verification.js';
import { findAnchorMessage, type Target } from './agent-targeting.js';
import type { StepResult } from './agent-output-parser.js';
import { resolveExecutionCwd, hasUncommittedChanges, readHeadHash } from './agent-loop-workspace.js';

/** B3b-i: 代码类 WU 判定与验证实现已抽到 ./wu-verification.js（F6-c，供强制收口与 /verify 端点复用） */
/** 步骤数上限：超限强制 in_review 交人工。review WU 单独放宽——
 *  评审职责是读不是写，无提交守卫豁免后正常 ≤5 步收口；阈值仅是防死循环的安全阀 */
const STEP_LIMIT = 15;
const REVIEW_STEP_LIMIT = 30;

/** recordResult 依赖面（由 AgentLoop 注入，避免反向 import 门面） */
export interface RecordResultDeps {
  workUnitService: WorkUnitService;
  fileStore: FileStore;
  role: AgentProfileData;
}

/** Record result: monitoring checkpoints + state transitions (zero token) */
export async function recordResult(deps: RecordResultDeps, target: Target, result: StepResult): Promise<void> {
  // B2: 测试特征 WU 守卫已在 agentStep 自行关闭 WU 并留痕，无需任何簿记/状态迁移
  if (result.action === 'skipped') return;
  const wuId = target.workUnit.id;
  const wu = await deps.workUnitService.getById(wuId);
  if (!wu) return;

  const persisted = (wu.metadata ? JSON.parse(wu.metadata) : {}) as WorkUnitMetadata;
  // 提交守卫/自动验证必须以「持久化 + 本 step metadataUpdates」的合并视图为准：
  // 首个 step 的 worktreePath 等字段由 agentStep 经 result.metadataUpdates 传入、
  // 此刻尚未落库；只看持久化值会让首 step 的 COMPLETE 退到主仓库（干净）做检查而漏拦
  // （e2e 实测：dev 在 worktree 改了未提交，守卫查主仓库放行 → 假 complete）。
  const metadata: WorkUnitMetadata = { ...persisted, ...result.metadataUpdates };
  // P0 修复 6: traceId（与 agentStep 同一来源，供日志行携带）
  const traceId = typeof metadata.traceId === 'string' && metadata.traceId ? metadata.traceId : undefined;

  // §10.5 提交守卫（发生在状态迁移之前，与 stepCount 守卫同层 —— 不动 VALID_TRANSITIONS）。
  // 路径解析或 git 调用失败一律静默跳过，绝不因基础设施故障阻断完成。
  // B3b-i: cwd 改走 resolveExecutionCwd —— 代码类 WU 在专属 worktree 下跑 git status。
  // review WU 整体豁免：评审职责是读不是写（cwd 解析到父 WU worktree，dev 的提交/
  // 工具产物与评审无关），工作区洁净不是它的责任——否则 COMPLETE 被反复打回空转。
  let action = result.action;
  const guardUpdates: Partial<WorkUnitMetadata> = {};
  let noCommitNotice = false;
  const workspaceRoot = wu.type === 'review' ? null : await resolveExecutionCwd(deps.workUnitService, wu, metadata);
  if (workspaceRoot) {
    if (action === 'complete' && hasUncommittedChanges(workspaceRoot)) {
      // COMPLETE 守卫：有未提交改动 → 打回按 PROGRESS 处理，提示注入下一轮 prompt
      action = 'progress';
      guardUpdates.commitGuardHint = '有未提交改动，请先 git add/commit 再报告完成';
      logger.info(`[AgentLoop] Commit guard: COMPLETE downgraded for ${wuId} (uncommitted changes)`);
    }
    if (action === 'progress') {
      // PROGRESS 无提交监视：HEAD 不变 → 累计；连续 3 步发一次频道提醒并归零
      const head = readHeadHash(workspaceRoot);
      if (head) {
        if (metadata.lastCommitHash === head) {
          const next = (metadata.noCommitSteps ?? 0) + 1;
          if (next >= 3) {
            noCommitNotice = true;
            guardUpdates.noCommitSteps = 0;
          } else {
            guardUpdates.noCommitSteps = next;
          }
        } else {
          guardUpdates.lastCommitHash = head;
          guardUpdates.noCommitSteps = 0;
        }
      }
    }
  }

  // §6-2 父 complete 守卫（与提交守卫同层，同一降级为 progress 的模式）：
  // 存在未完结（unassigned/active/blocked/in_review）子 WU 时不允许 complete ——
  // 父一旦抢先 in_review，聚合的状态序防回退会让「子后完成」无法改写父状态（收口顺序：父必须等子）。
  if (action === 'complete') {
    const unfinishedChildren = await listUnfinishedChildren(deps.fileStore, wuId);
    if (unfinishedChildren.length > 0) {
      action = 'progress';
      guardUpdates.childGuardHint = `存在未完结子任务（${unfinishedChildren.join(', ')}），等待其全部完成后再报告 COMPLETE`;
      logger.info(`[AgentLoop] Child guard: COMPLETE downgraded for ${wuId} (unfinished children: ${unfinishedChildren.length})`);
    }
  }

  // B3b-i（决策 D3 前半）: COMPLETE 前自动验证 —— 仅代码类 WU（有专属 worktree）。
  // 提交守卫/子任务守卫已通过（action 仍为 complete）才跑；命令解析：覆盖 > 约定（见 resolveVerifyCommands）。
  // 全绿 → verifyReport 落档 + 频道简报；任一失败 → 降级 progress，失败命令+输出尾部注入下一轮 prompt，
  // verifyFailCount ≥3 → blocked。无 worktree / 无命令可跑 → 跳过（维持现状）。
  let verifyBlocked = false;
  let verifyPassNotice: string | null = null;
  // F6-c：本 step 是否已跑过验证（COMPLETE 守卫）——步骤超限强制收口路径据此避免重复跑
  let verifyGuardRan = false;
  if (action === 'complete'
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
    verifyGuardRan = true;
    if (outcome.failure) {
      const failCount = (metadata.verifyFailCount ?? 0) + 1;
      guardUpdates.verifyFailCount = failCount;
      guardUpdates.verifyFailHint = [
        `自动验证未通过（第 ${failCount} 次），请先修复再报告完成`,
        `失败命令: ${outcome.failure.command}`,
        `输出尾部:\n${outcome.failure.tail}`,
      ].join('\n');
      // F6（决策 1）：验证失败同样落台账 l1（rejected 留痕，后续全绿 approved 覆盖）
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'rejected',
        by: deps.role.id,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
      });
      action = 'progress';
      verifyBlocked = failCount >= 3;
      logger.info(`[AgentLoop] Verify guard: COMPLETE downgraded for ${wuId} (command failed: ${outcome.failure.command}, count ${failCount})`);
    } else {
      guardUpdates.verifyFailCount = 0;
      if (outcome.ran.length > 0) {
        guardUpdates.verifyReport = {
          commands: outcome.ran,
          source: outcome.source,
          passedAt: new Date().toISOString(),
        };
        // F6（决策 1）：验证全绿落台账 l1
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: deps.role.id,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        verifyPassNotice = `✅ 自动验证通过（${outcome.ran.length} 条）：${outcome.ran.join('；')}`;
        logger.info(`[AgentLoop] Verify guard: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }
  }

  // A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）。
  // 通过：建子单 + collab 元数据 + delegate 卡片（父 WU 状态不变，按 progress 继续）；
  // 拒绝：降级 NEED_INPUT（现有 blocked 路径），频道发「拟委派…需人工确认」请人裁决。
  if (action === 'delegate' && result.delegate) {
    const gate = await checkDelegation({
      fileStore: deps.fileStore,
      parent: wu,
      delegator: deps.role,
      targetName: result.delegate.targetName,
    });
    if (gate.pass && gate.target) {
      const parentCollab = effectiveParentCollab(wu, deps.role.id);
      const childCollab: CollabMeta = {
        rootId: parentCollab.rootId,
        depth: parentCollab.depth + 1,
        chain: [...parentCollab.chain, gate.target.id],
        delegatedBy: { profileId: deps.role.id, workUnitId: wuId },
        delegationCount: 0,
      };
      await deps.workUnitService.create({
        scope: result.delegate.scope,
        type: wu.type,
        parentId: wuId,
        assigneeId: gate.target.id, // unassigned 语义 = 目标 profile id（同 @mention 点名，§1.2-b）
        channelId: wu.channelId,
        projectPath: wu.projectPath,
        workspaceId: wu.workspaceId ?? null,
        reqId: wu.reqId ?? null,
        status: 'unassigned',
        metadata: { creationMode: 'agent-delegate', collab: childCollab },
      });
      // 父 WU 补记/累加 collab（根 WU 首次委派时从无 collab 合并为 depth=0 的根记录）
      guardUpdates.collab = { ...parentCollab, delegationCount: (parentCollab.delegationCount ?? 0) + 1 };
      action = 'progress';
      // delegate 卡片即本步的 progress 消息（走下方统一回帖路径，含新鲜度检查）
      result.summary = `@${deps.role.name} 委派 @${gate.target.name}：${result.delegate.scope}（深度 ${childCollab.depth}/${resolveMaxDepth()}）`;
      logger.info(`[AgentLoop] Delegation created: ${wuId} → @${gate.target.name} (depth ${childCollab.depth})`);
    } else {
      action = 'need_input';
      result.summary = `拟委派 @${result.delegate.targetName}：${result.delegate.scope}，因 ${gate.reason ?? '未知原因'} 需人工确认`;
      logger.info(`[AgentLoop] Delegation rejected for ${wuId}: ${gate.reason}`);
    }
  }

  // §4.2 发言层新鲜度检查（仅 recordResult → postToDiscussionSpace 结果回帖路径，系统通知不受影响）：
  // step 期间房间有外部新消息 → 不直接发帖，新消息写入 pendingReplies 注入下一轮 prompt，
  // 本步按 progress 处理；同一结果连续 2 次被拦截仍判定要发 → 照发并注明「发送时房间有新消息」。
  let skipResultPost = false;
  const freshnessUpdates: Partial<WorkUnitMetadata> = {};
  if (result.channelVersion && wu.channelId) {
    const arrived = await deps.fileStore.getMessagesSinceLine(wu.channelId, result.channelVersion.lineCount);
    // 本 loop 自己发的消息（如 delegate 卡片）不算「房间已变」
    const external = arrived.filter(m => !(m.authorType === 'agent' && m.agentName === deps.role.name));
    const interrupts = metadata.freshnessInterrupts ?? 0;
    if (external.length > 0 && interrupts < 2) {
      skipResultPost = true;
      action = 'progress';
      freshnessUpdates.pendingReplies = external.map(m =>
        m.authorType === 'agent' ? `[${m.agentName ?? 'agent'}]: ${m.content}` : m.content
      );
      freshnessUpdates.freshnessInterrupts = interrupts + 1;
      logger.info(`[AgentLoop] Freshness: result post held for ${wuId} (${external.length} new message(s), interrupt ${interrupts + 1}/2)`);
    } else {
      if (external.length > 0) {
        result.summary = `${result.summary}（发送时房间有新消息）`;
      }
      if (interrupts > 0) {
        freshnessUpdates.freshnessInterrupts = 0;
      }
    }
  }

  const stepCount = (metadata.stepCount ?? 0) + 1;
  let consecutiveStuck = action === 'progress' ? 0 : (metadata.consecutiveStuck ?? 0) + 1;

  // F6-c（断点 1）：步骤超限强制收口前补跑 L1 —— COMPLETE 验证守卫只在 action=complete 时跑，
  // 超限路径（任意 action）此前完全跳过验证，代码类 WU 被强制 in_review 时永远缺 l1。
  // 台账写法与 COMPLETE 守卫同结构（approved 全绿 + verifyReport / rejected 留痕），
  // 但不计 verifyFailCount、不改 blocked 语义——仍按原计划进 in_review 交人工。
  // 本 step COMPLETE 守卫已跑过验证时不重复跑；无命令可跑 → 不写 attestation（维持现状）。
  // attestation 合进下方同一次 metadata 原子写回，不单独写库（防竞态）。
  const forceClosing = stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT);
  if (forceClosing && !verifyGuardRan
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    const outcome = await runWuVerification(wu, metadata, metadata.worktreePath);
    if (outcome.failure) {
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'rejected',
        by: deps.role.id,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
      });
      logger.info(`[AgentLoop] Force-close verify: l1 rejected for ${wuId} (command failed: ${outcome.failure.command})`);
    } else if (outcome.ran.length > 0) {
      guardUpdates.verifyReport = {
        commands: outcome.ran,
        source: outcome.source,
        passedAt: new Date().toISOString(),
      };
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'approved',
        by: deps.role.id,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: outcome.ran.join('；').slice(0, 300),
      });
      logger.info(`[AgentLoop] Force-close verify: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
    }
  }

  // F5: NEED_INPUT 挂起标记（等待人类回复）；其他结果清除挂起标记（恢复后继续执行）
  const waitingUpdates: Partial<WorkUnitMetadata> = action === 'need_input'
    ? {
        waitingForInput: true,
        waitingQuestion: result.summary,
        waitingSince: new Date().toISOString(),
        waitingReminded: false,
      }
    : metadata.waitingForInput
      ? { waitingForInput: false, waitingReminded: false }
      : {};

  // B4（2026-08-03 token-burn issue P0-2）：blocked 原因落盘 —— 审计类 WU 全部 blocked
  // 却无据可查的事故教训；本步不走 blocked 路径时清除陈旧原因（恢复执行即翻篇）。
  const blockReasonUpdates: Partial<WorkUnitMetadata> = {};
  if (verifyBlocked) {
    blockReasonUpdates.blockReason = `verify-failed x${guardUpdates.verifyFailCount}: 自动验证连续失败`;
  } else if (consecutiveStuck >= 3) {
    blockReasonUpdates.blockReason = action === 'failed' && result.summary
      ? `stuck: 连续 3 步无进展（${result.summary.slice(0, 200)}）`
      : 'stuck: 连续 3 步无进展';
  } else if (action === 'need_input') {
    blockReasonUpdates.blockReason = `need-input: ${result.summary.slice(0, 200)}`;
  } else if (metadata.blockReason) {
    blockReasonUpdates.blockReason = undefined; // undefined 在 JSON 序列化时丢弃 → 清除
  }

  // Single atomic metadata write: merges agentStep updates (sessionId/startedAt/sessionResumes)
  // with monitoring counters (stepCount/consecutiveStuck) — fixes C-3 non-atomic write
  await deps.workUnitService.update(wuId, {
    metadata: { ...metadata, ...result.metadataUpdates, ...waitingUpdates, ...guardUpdates, ...freshnessUpdates, ...blockReasonUpdates, stepCount, consecutiveStuck },
  });

  // P0 修复 6: trace 锚点 — 有 traceId 的 WU（频道消息链路）每步留一条可 grep 日志
  if (traceId) {
    logger.info(`[AgentLoop] Step recorded for ${wuId}`, { traceId, action, stepCount });
  }

  // §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零，之后每 3 步再提醒）
  if (noCommitNotice) {
    await postToDiscussionSpace(deps, wuId, `任务 ${wuId} 连续 3 步无新提交，请注意及时 commit`);
  }

  // B3b-i: 自动验证连续失败 ≥3 次 → blocked 并频道说明（优先于 step limit / 状态迁移）
  if (verifyBlocked) {
    if (wu.status !== 'blocked') {
      await deps.workUnitService.transitionStatus(wuId, 'blocked');
    }
    // 2026-07 PMO-flow UX（§6-3）：验证失败打回/转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
    await postToDiscussionSpace(
      deps,
      wuId,
      `自动验证连续失败 ${guardUpdates.verifyFailCount} 次，任务已转 blocked，等待人类介入。最近失败命令与输出已记录到任务上下文`,
      await milestoneMeta(deps, wu, metadata),
    );
    return;
  }

  // B3b-i: 验证全绿 → 频道简报（跑了哪几条；仅当 COMPLETE 未被其他守卫拦截）
  if (verifyPassNotice && action === 'complete') {
    await postToDiscussionSpace(deps, wuId, verifyPassNotice);
  }

  // Monitoring: step limit（review WU 用放宽阈值，见 REVIEW_STEP_LIMIT 注释）
  if (stepCount > (wu.type === 'review' ? REVIEW_STEP_LIMIT : STEP_LIMIT)) {
    // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
    if (wu.status === 'blocked') {
      await deps.workUnitService.transitionStatus(wuId, 'active');
    }
    await deps.workUnitService.transitionStatus(wuId, 'in_review');
    await postToDiscussionSpace(deps, wuId, '步骤数超限，强制提交审查');
    return;
  }
  // Monitoring: stuck detection
  if (consecutiveStuck >= 3) {
    await deps.workUnitService.transitionStatus(wuId, 'blocked');
    // W-3 接线：执行失败导致的 blocked 在频道说明失败原因（summary 含 CLI 错误详情）
    const stuckReason = action === 'failed' && result.summary ? `（${result.summary}）` : '';
    // 2026-07 PMO-flow UX（§6-3）：blocked 转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
    await postToDiscussionSpace(deps, wuId, `连续 3 步无进展${stuckReason}，等待人类介入`, await milestoneMeta(deps, wu, metadata));
    return;
  }

  // State transitions by action (§10.5: 使用守卫降级后的 action；§4.2: 新鲜度拦截时不发帖)
  // 非空守卫：summary 为空（如 CLI 成功但无文本输出）不发帖，避免频道空消息。
  switch (action) {
    case 'progress':
      if (!skipResultPost && result.summary.trim().length > 0) await postToDiscussionSpace(deps, wuId, result.summary);
      if (wu.status === 'blocked') {
        await deps.workUnitService.transitionStatus(wuId, 'active');
      }
      break;
    case 'complete':
      // 2026-07 PMO-flow UX（§6-3）：COMPLETE 完成汇报里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      if (!skipResultPost && result.summary.trim().length > 0) {
        await postToDiscussionSpace(deps, wuId, result.summary, await milestoneMeta(deps, wu, metadata));
      }
      // C-2 fix: blocked→in_review is not in VALID_TRANSITIONS, go through active first
      if (wu.status === 'blocked') {
        await deps.workUnitService.transitionStatus(wuId, 'active');
      }
      await deps.workUnitService.transitionStatus(wuId, 'in_review');
      // P0 修复（reviewReport 回传断链）：review 子 WU 不再被二次评审
      // （ReviewDispatcher 路径 A 跳过 type=review），complete 后直接收口 done，
      // 触发路径 B 读取 metadata.reviewReport 判定父 WU reviewPassed/reviewRejected。
      if (wu.type === 'review') {
        await deps.workUnitService.transitionStatus(wuId, 'done');
      }
      break;
    case 'need_input':
      // 2026-07 PMO-flow UX（§6-3）：NEED_INPUT 里程碑 —— meta 带 pmoId（可解析时）+ atHuman
      if (!skipResultPost) {
        await postToDiscussionSpace(deps, wuId, `需要输入: ${result.summary}`, await milestoneMeta(deps, wu, metadata));
      }
      // F5: 挂起 — 守卫重复 NEED_INPUT（blocked → blocked 不在 VALID_TRANSITIONS 中）
      if (wu.status !== 'blocked') {
        await deps.workUnitService.transitionStatus(wuId, 'blocked');
      }
      break;
    case 'failed':
      // W-3 接线：CLI 执行失败 —— 不发频道消息、不做状态迁移（保持 active 待重试）；
      // consecutiveStuck 已在上方累计，满 3 次走 blocked 路径并说明失败原因。
      break;
  }
}

/** §6-2 父 complete 守卫：未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
async function listUnfinishedChildren(fileStore: FileStore, wuId: string): Promise<string[]> {
  const snapshots = await fileStore.getIndex();
  return snapshots
    .filter(s => s.parentId === wuId && !['done', 'closed'].includes(s.status))
    .map(s => s.id);
}

/** Post message to discussion space（经 ChannelMessageService：eventBus + SSE，频道页实时可见）。
 *  meta 仅里程碑消息携带（2026-07 PMO-flow UX §6-3：pmoId/atHuman），普通 progress 不带。 */
export async function postToDiscussionSpace(deps: RecordResultDeps, workUnitId: string, content: string, meta?: MessageMeta): Promise<void> {
  if (!content.trim()) return;
  const wu = await deps.workUnitService.getById(workUnitId);
  if (!wu?.channelId) return;

  const anchor = await findAnchorMessage(workUnitId, deps.fileStore);
  // 绑定本 loop 的 fileStore（测试注入临时 store；生产与全局同目录），事件形状与全局 service 一致
  await new ChannelMessageService(deps.fileStore).createAgentMessage(wu.channelId, deps.role.name, content, {
    replyToId: anchor?.id,
    workUnitId,
    ...(meta ? { meta } : {}),
  });
}

/**
 * 2026-07 PMO-flow UX（§6-3）：里程碑消息 meta 的归属 PMO 解析。
 * 解析链复用 pmo-branch-resolver（①ownershipProjectId ②reqId→Requirement.projectId ③pmoProjectId）；
 * metadata 用「持久化 + 本 step metadataUpdates」合并视图（pmoProjectId 可能本 step 刚落档）。
 * best-effort —— 解析失败/无归属 → null（消息 meta 不携带 pmoId）。
 */
async function resolveMilestonePmoId(deps: RecordResultDeps, wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<string | null> {
  return resolvePmoProjectIdForWU(
    { reqId: wu.reqId ?? null, metadata: JSON.stringify(metadata) },
    deps.fileStore,
  ).catch(() => null);
}

/** 2026-07 PMO-flow UX（§6-3）：里程碑消息 meta（pmoId 解析不到则不携带；atHuman 标记需人看） */
async function milestoneMeta(deps: RecordResultDeps, wu: WorkUnitData, metadata: WorkUnitMetadata): Promise<MessageMeta> {
  const pmoId = await resolveMilestonePmoId(deps, wu, metadata);
  return { ...(pmoId ? { pmoId } : {}), atHuman: true };
}
