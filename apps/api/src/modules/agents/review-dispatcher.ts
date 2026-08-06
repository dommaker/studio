/**
 * ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派
 *
 * 订阅 workunit.status_changed：
 *   路径 A：父 WU -> in_review -> 创建 review 子 WU（未指派，走 claim 涌现；绕过 DelegationGate）
 *   路径 B：子 WU（type=review）-> done -> 解析 metadata.reviewReport -> 父 WU reviewPassed/reviewRejected
 *     （reviewReport 由评审方的 AgentLoop 在子 WU complete 时解析 REVIEW_RESULT 写入；
 *       缺失/无法解析 -> 不默认拒绝，频道发系统消息转人工，父 WU 保持 in_review）
 *
 * F4 reviewer 解锚（2026-07-28 分析文档，决策 5）：
 *   不再按 description 含 'reviewer' 找具名角色（字符串锚点已废除）——评审子 WU
 *   assigneeId=null 未指派，任何频道成员可认领；metadata.excludeAssignee=实现者 profile id
 *   保证"不许自己审自己"（agent-loop observe 过滤）。频道内除实现者外无其他 active 成员时
 *   自评兜底：不加排除、metadata.selfReview=true、频道发系统消息提醒人工复核。
 *
 * 设计决策（design.md §1.2）：
 *   D5: 状态机驱动，不走 agent DELEGATE 协议
 *   D6: 绕过 DelegationGate（系统代派不是 agent 主动 DELEGATE）
 *   D7: 旧 reviewAgent.review() 已删除（2026-07-28，逾期收尾）；review.service 仅保留 reviewDiff() 供 /review/diff 管理端点
 */

import { eventBus, logger, parseChannels, deriveDisplayState, type FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { readCollab } from '../workunit/delegation-gate.js';
import { postWuSystemMessage } from '../workunit/wu-messenger.js';
import { parseWuMetadata, clearSessionBookkeeping } from '../workunit/wu-metadata.js';
import type { ParsedReviewReport } from './review-contract.js';

export class ReviewDispatcher {
  private subscribed = false;

  constructor(
    private fileStore: FileStore,
    private workUnitService: WorkUnitService,
  ) {}

  /** 订阅 workunit.status_changed 事件。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', async (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      // 路径 A：父 WU 进入 in_review -> 尝试创建 review 子 WU
      // （跳过 type='review'：review 子 WU 不需要再被 review；
      //   跳过 type='analysis'：分析结论的评审 = 人工确认（F6 l3），diff-only 契约
      //   对非代码产物恒 needs-info 转人工纯噪声；接力提示与派工见 pmo/analysis-handoff.ts）
      if (wu.status === 'in_review' && wu.type !== 'review' && wu.type !== 'analysis') {
        await this.handleParentInReview(wu).catch(err =>
          logger.warn('[ReviewDispatcher] handleParentInReview failed', { wuId: wu.id, error: String(err) }),
        );
      }
      // 路径 B：子 WU（type='review'）完成 -> 处理父 WU review 结果
      if (wu.status === 'done' && wu.type === 'review' && wu.parentId) {
        await this.handleReviewChildDone(wu).catch(err =>
          logger.warn('[ReviewDispatcher] handleReviewChildDone failed', { childId: wu.id, error: String(err) }),
        );
      }
    });
  }

  /** 频道 active 成员（不含 studio）；members 未回填（历史频道）返回 null = 成员未知 */
  private async getChannelActiveMembers(channelId: string): Promise<AgentProfileData[] | null> {
    const channel = await this.fileStore.getChannel(channelId);
    // P0 修复：安全解析 members —— 损坏 JSON / 非数组 / 双重编码一律按无成员处理
    const memberIds = parseChannels(channel?.members);
    if (memberIds.length === 0) return null;

    const allProfiles = await this.fileStore.listProfiles({ status: 'active' });
    return allProfiles.filter(p => memberIds.includes(p.id) && p.name !== 'studio');
  }

  /**
   * assigneeId 有两种形态——指名未认领时是 profile id，
   * 已认领后被 claim 改写为 instance id（instance.state.roleId 才是 profile id）。
   * 排除约束/台账归属必须落在 profile id 上（agent-loop observe 按 this.role.id 比对）。
   * 单 WU 变体（按 id 点查 getProfile → getState）；批量场景用
   * workunit/assignee-resolver.ts 的 buildAssigneeProfileResolver（一次建 map，
   * 同语义、map-first，仅当某 id 同时为 profile id 与 instance id 时顺序不同——实际不存在）。
   */
  private async resolveProfileId(assigneeId: string | null): Promise<string | null> {
    if (!assigneeId) return null;
    if (await this.fileStore.getProfile(assigneeId)) return assigneeId;
    const state = await this.fileStore.getState(assigneeId).catch(() => null);
    return state?.roleId ?? null;
  }

  /** 父 WU 进入 in_review 时的处理 */
  private async handleParentInReview(parent: WorkUnitData): Promise<void> {
    if (!parent.channelId) return;

    // 同父唯一性校验：已有未完结 review 子 WU -> 跳过
    if (await this.hasUnfinishedReviewChild(parent.id)) return;

    await this.createReviewChildFor(parent);
  }

  /** 同父唯一性：已有未完结 review 子 WU */
  private async hasUnfinishedReviewChild(parentId: string): Promise<boolean> {
    const snapshots = await this.fileStore.getIndex();
    return snapshots.some(s =>
      s.parentId === parentId
      && s.type === 'review'
      && s.status !== 'done'
      && s.status !== 'closed',
    );
  }

  /**
   * 建评审子 WU + 自评兜底频道提醒（路径 A 事件链与 F6-c 人工补派共用）。
   * F4: 评审子 WU 未指派走涌现；排除实现者（决策 5 衔接顺序）：
   * 成员已知且除实现者外无他人 → 自评兜底（不加排除 + selfReview 标记 + 频道提醒）；
   * 成员未知（历史频道未回填 members）同样保守处理为自评兜底。
   */
  private async createReviewChildFor(parent: WorkUnitData): Promise<WorkUnitData> {
    const members = await this.getChannelActiveMembers(parent.channelId!);
    const implementerId = await this.resolveProfileId(parent.assigneeId);
    const eligible = members?.filter(p => p.id !== implementerId) ?? null;
    const selfReview = !eligible || eligible.length === 0;

    const child = await this.createReviewWorkUnit(parent, {
      excludeAssignee: selfReview ? null : implementerId,
      selfReview,
    });

    if (selfReview) {
      // 决策 5：提醒是给人看的（建议人工复核/加成员），自评是保流转的——二者不冲突
      await this.postSystemMessage(
        parent,
        `任务「${(parent.scope ?? '').slice(0, 50)}」已进入评审（#${child.id.slice(0, 8)}）：频道内无其他可评审成员，未排除实现者，可能由实现者自评——建议人工复核或为频道添加成员`,
      ).catch(err =>
        logger.warn('[ReviewDispatcher] Post self-review notice failed (non-blocking)', {
          parentId: parent.id, error: String(err),
        })
      );
    }

    return child;
  }

  /**
   * F6-c（断点 3）：人工补派评审（POST /api/v1/workunits/:id/dispatch-review 的服务层，同步调用）。
   * 复用路径 A 的建单逻辑（excludeAssignee/自评兜底/同父唯一性不变）。守卫：
   *   type=review/analysis → 拒绝（设计如此：review 不再被评审；analysis 验收闸是人工 L3）；
   *   status 不在 in_review/done → 拒绝（active/blocked 等应先走正常收口）；
   *   deriveDisplayState 判定 l2 已达成 → 拒绝（无需补派；rejected 留痕不算达成，允许重派）；
   *   无频道 → 拒绝（评审子 WU 经频道涌现认领，无频道必卡死）；
   *   已有未完结评审子 WU → 拒绝（同父唯一性）。
   * 返回新建的 review 子 WU。
   */
  async dispatchReviewNow(parentWuId: string): Promise<WorkUnitData> {
    const parent = await this.workUnitService.getById(parentWuId);
    if (!parent) throw new Error(`WorkUnit ${parentWuId} not found`);
    if (parent.type === 'review' || parent.type === 'analysis') {
      throw new Error(`WorkUnit type ${parent.type} is not reviewable (review 不再被评审；analysis 验收闸是人工 L3)`);
    }
    if (parent.status !== 'in_review' && parent.status !== 'done') {
      throw new Error(`Cannot dispatch review: current status is ${parent.status}, expected in_review/done`);
    }
    if (deriveDisplayState({ status: parent.status, metadata: parent.metadata }).evidence.l2) {
      throw new Error('L2 review evidence already present — 无需补派');
    }
    if (!parent.channelId) {
      throw new Error('WorkUnit has no channel — 评审子 WU 无法经频道涌现认领');
    }
    if (await this.hasUnfinishedReviewChild(parent.id)) {
      throw new Error('Review child already in flight — 已有未完结的评审子 WU');
    }

    const child = await this.createReviewChildFor(parent);
    logger.info('[ReviewDispatcher] Review re-dispatched manually', { parentId: parent.id, childId: child.id, parentStatus: parent.status });
    return child;
  }

  /** 创建 review 子 WU（未指派走 claim 涌现；绕过 DelegationGate，design.md D6） */
  private async createReviewWorkUnit(
    parent: WorkUnitData,
    opts: { excludeAssignee: string | null; selfReview: boolean },
  ): Promise<WorkUnitData> {
    const parentMeta = parseWuMetadata(parent.metadata);
    const parentCollab = parentMeta.collab ?? {
      rootId: parent.id,
      depth: 0,
      chain: [],
      delegationCount: 0,
    };

    const childMetaRaw: WorkUnitMetadata = {
      ...parentMeta,
      collab: {
        rootId: parentCollab.rootId,
        depth: parentCollab.depth + 1,
        // 评审人未知（涌现认领），chain 不含评审者；认领后由 loop 侧谱系自证
        chain: [...parentCollab.chain],
        delegatedBy: { profileId: parent.assigneeId ?? '', workUnitId: parent.id },
        delegationCount: 0,
      },
      ...(opts.excludeAssignee ? { excludeAssignee: opts.excludeAssignee } : {}),
      ...(opts.selfReview ? { selfReview: true } : {}),
      // R3: 评审输入契约落档（审计用——台账可追溯本评审的输入形态）
      reviewInput: { mode: 'diff-only', skill: 'code-review' },
    };

    // 会话/执行簿记绝不继承到子 WU：12 字段权威清单与 2026-07-30 事故实录已收敛到
    // workunit/wu-metadata.ts 的 clearSessionBookkeeping（返回浅拷贝，不改 childMetaRaw）——
    // agent-loop 新增簿记字段必须同步该清单，否则静默泄漏进 review 子 WU
    const childMeta = clearSessionBookkeeping(childMetaRaw);

    // R3 评审输入契约（2026-07-28 分析文档 §4-R3）：diff-only + code-review skill。
    // 独立性保障：只给代码差异，不给实现叙述当判断依据（父 scope 仅作背景定位）；
    // 上下文失效（diff 取不到/变更无法定位）→ verdict=needs-info 报备，
    // parseReviewReport 对非 pass/reject 一律返回 null → ReviewDispatcher 转人工（不猜不硬判）。
    const baseBranch = typeof parentMeta.worktreeBaseBranch === 'string' && parentMeta.worktreeBaseBranch.length > 0
      ? parentMeta.worktreeBaseBranch
      : null;
    const diffHint = baseBranch
      ? `git log ${baseBranch}..HEAD --oneline 看提交清单，git diff ${baseBranch}...HEAD 看全部变更`
      : 'git log 看提交清单，git diff 看全部变更（先确认相对哪个基线分支）';
    const scope = `审查代码变更（diff-only 输入契约）+code-review

你只审查代码差异本身——实现者的任务描述仅作背景定位，不作为通过依据。
1. 在工作区执行 ${diffHint}；
2. 按 code-review skill 的标准逐文件审查差异；
3. 上下文失效（diff 取不到/仓库状态异常/变更无法定位）时不要猜测——verdict 报 "needs-info" 转人工；
4. 背景（仅供定位）：${parent.scope?.slice(0, 200) ?? ''}

完成审查后，除 ACTION 行外，还必须在输出的最后一行给出结构化结论：
REVIEW_RESULT: {"verdict":"pass"|"reject"|"needs-info","summary":"一句话结论","issues":[{"severity":"error"|"warn"|"info","message":"问题描述"}]}
（verdict=pass 通过 / reject 打回 / needs-info 上下文不足转人工；summary、issues 可省略。缺少该行将转人工评审。）`;

    const child = await this.workUnitService.create({
      type: 'review',
      // P0 修复（reviewReport 回传断链）：scope 写入 REVIEW_RESULT 输出约定 ——
      // 评审方 AgentLoop complete 时据此解析结构化结论写入 metadata.reviewReport
      scope,
      // F4: 未指派 —— 任何频道成员可认领（排除实现者由 metadata.excludeAssignee 约束）
      assigneeId: null,
      status: 'unassigned',
      channelId: parent.channelId,
      parentId: parent.id,
      workspaceId: parent.workspaceId ?? null,
      reqId: typeof parentMeta.reqId === 'string' ? parentMeta.reqId : null,
      metadata: childMeta,
    });

    logger.info('[ReviewDispatcher] Created review child WU (unassigned)', {
      parentId: parent.id,
      childId: child.id,
      excludeAssignee: opts.excludeAssignee,
      selfReview: opts.selfReview,
    });

    return child;
  }

  /** 子 WU done 时的处理：解析 reviewReport -> 父 WU reviewPassed/reviewRejected */
  private async handleReviewChildDone(child: WorkUnitData): Promise<void> {
    const parent = await this.workUnitService.getById(child.parentId!);
    if (!parent) return;
    // F6-c（断点 3）：父 status==='in_review' 正常收口（现状）；
    // 父已被人工直推 done 且 l2 缺失（approved 口径）→ 走 reviewPassed 的幂等补写把迟到结论落账；
    // 其余情况（done 已有 l2 / active 等）仍跳过。
    const parentDoneMissingL2 = parent.status === 'done'
      && !deriveDisplayState({ status: parent.status, metadata: parent.metadata }).evidence.l2;
    if (parent.status !== 'in_review' && !parentDoneMissingL2) return; // 父已被手动处理 -> 跳过

    const childMeta = parseWuMetadata(child.metadata);
    // 落档形状由 review-contract.ts 定义（与 WorkUnitMetadata.reviewReport 结构一致）
    const report = childMeta.reviewReport as ParsedReviewReport | undefined;

    if (!report) {
      // 父已 done：无可补写的结论，静默跳过（转人工提醒对一个已收口的 WU 是纯噪声）
      if (parent.status !== 'in_review') {
        logger.warn('[ReviewDispatcher] Review child done without reviewReport; parent already done — 跳过', {
          childId: child.id,
          parentId: parent.id,
        });
        return;
      }
      // P0 修复：reviewer 输出无法解析 → 不再默认 reviewRejected（误杀）。
      // 父 WU 保持 in_review 不动，频道发系统消息转人工裁决。
      logger.warn('[ReviewDispatcher] Review child done without parseable reviewReport — 转人工', {
        childId: child.id,
        parentId: parent.id,
      });
      await this.postSystemMessage(
        parent,
        `任务「${(parent.scope ?? '').slice(0, 50)}」的审查结论无法解析（reviewer 未输出 REVIEW_RESULT），已转人工评审，请人工处理`,
      );
      return;
    }

    // F6（决策 1）：评审结论同时落父 WU 台账 l2——by 取评审者 profile id，
    // selfReview 透传子 WU 标记（人类待办/指标据此捞自评），ref 指回评审子 WU。
    const reviewerProfileId = await this.resolveProfileId(child.assigneeId);
    const attestation = {
      by: reviewerProfileId ?? child.assigneeId ?? child.id,
      kind: 'agent-review' as const,
      ...(childMeta.selfReview === true ? { selfReview: true } : {}),
      ref: child.id,
      ...(typeof report.reason === 'string' ? { summary: report.reason.slice(0, 200) } : {}),
    };

    if (report.approved) {
      // 父 in_review → 正常 reviewPassed 收口；父 done 缺 l2 → F6-c 幂等补写 l2（不动状态）
      await this.workUnitService.reviewPassed(parent.id, attestation);
    } else {
      // 父已 done：迟到的 reject 不打回人工已收口的 WU（验收权只在人，A2A §4.4），
      // 频道发系统消息请人工复核；l2 保持缺失，可由 dispatch-review 重派或人工处置
      if (parent.status === 'done') {
        const reason = report.reason
          ?? report.issues?.filter(i => i.severity === 'error').map(i => i.message).join('; ')
          ?? 'reviewer 拒绝';
        logger.warn('[ReviewDispatcher] Late review rejected but parent already done — 转人工复核', {
          childId: child.id,
          parentId: parent.id,
        });
        await this.postSystemMessage(
          parent,
          `任务「${(parent.scope ?? '').slice(0, 50)}」的迟到审查结论为 reject（${reason.slice(0, 200)}），但任务已由人工收口 done，请人工复核是否需要返工`,
        );
        return;
      }
      const reason = report.reason
        ?? report.issues?.filter(i => i.severity === 'error').map(i => i.message).join('; ')
        ?? 'reviewer 拒绝';
      await this.workUnitService.reviewRejected(parent.id, reason, attestation);
    }
  }

  /**
   * 向父 WU 所在频道发系统消息（转人工通知；经 wu-messenger 统一出口：eventBus + SSE）。
   * 2026-07 PMO-flow UX（§6-3）：评审结果类转人工里程碑 —— meta 带 pmoId（可解析时）+ atHuman
   * （NotificationBell 监听 meta.atHuman 的 SSE 消息，pmoId 供跳转 PMO 详情）。
   */
  private async postSystemMessage(parent: WorkUnitData, content: string): Promise<void> {
    await postWuSystemMessage(parent, content, { milestone: true, fileStore: this.fileStore });
  }
}

// 单例（懒初始化）
let _reviewDispatcher: ReviewDispatcher | null = null;

export function getReviewDispatcher(): ReviewDispatcher {
  if (!_reviewDispatcher) {
    const { FileStore } = require('@dommaker/studio-shared') as typeof import('@dommaker/studio-shared');
    const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');
    const fileStore = new FileStore();
    const workUnitService = new WorkUnitService(fileStore);
    _reviewDispatcher = new ReviewDispatcher(fileStore, workUnitService);
  }
  return _reviewDispatcher;
}
