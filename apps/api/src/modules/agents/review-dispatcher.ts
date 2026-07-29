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

import { randomUUID } from 'crypto';
import { eventBus, logger, parseChannels, type FileStore, type AgentProfileData, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { readCollab } from '../workunit/delegation-gate.js';
import { findAnchorMessage } from './agent-loop.js';

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
      // （跳过 type='review' 的 WU：review 子 WU 不需要再被 review）
      if (wu.status === 'in_review' && wu.type !== 'review') {
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
   * 实现者 profile id 解析：assigneeId 有两种形态——指名未认领时是 profile id，
   * 已认领后被 claim 改写为 instance id（instance.state.roleId 才是 profile id）。
   * 排除约束必须落在 profile id 上（agent-loop observe 按 this.role.id 比对）。
   */
  private async resolveImplementerProfileId(parent: WorkUnitData): Promise<string | null> {
    const id = parent.assigneeId;
    if (!id) return null;
    if (await this.fileStore.getProfile(id)) return id;
    const state = await this.fileStore.getState(id).catch(() => null);
    return state?.roleId ?? null;
  }

  /** 父 WU 进入 in_review 时的处理 */
  private async handleParentInReview(parent: WorkUnitData): Promise<void> {
    if (!parent.channelId) return;

    // 同父唯一性校验：已有未完结 review 子 WU -> 跳过
    const snapshots = await this.fileStore.getIndex();
    const existingReview = snapshots.some(s =>
      s.parentId === parent.id
      && s.type === 'review'
      && s.status !== 'done'
      && s.status !== 'closed',
    );
    if (existingReview) return;

    // F4: 评审子 WU 未指派走涌现；排除实现者（决策 5 衔接顺序）：
    // 成员已知且除实现者外无他人 → 自评兜底（不加排除 + selfReview 标记 + 频道提醒）；
    // 成员未知（历史频道未回填 members）同样保守处理为自评兜底。
    const members = await this.getChannelActiveMembers(parent.channelId);
    const implementerId = await this.resolveImplementerProfileId(parent);
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
  }

  /** 创建 review 子 WU（未指派走 claim 涌现；绕过 DelegationGate，design.md D6） */
  private async createReviewWorkUnit(
    parent: WorkUnitData,
    opts: { excludeAssignee: string | null; selfReview: boolean },
  ): Promise<WorkUnitData> {
    const parentMeta = parent.metadata ? JSON.parse(parent.metadata) as WorkUnitMetadata : {};
    const parentCollab = parentMeta.collab ?? {
      rootId: parent.id,
      depth: 0,
      chain: [],
      delegationCount: 0,
    };

    const childMeta: WorkUnitMetadata = {
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
    };

    const child = await this.workUnitService.create({
      type: 'review',
      // P0 修复（reviewReport 回传断链）：scope 写入 REVIEW_RESULT 输出约定 ——
      // 评审方 AgentLoop complete 时据此解析结构化结论写入 metadata.reviewReport
      scope: `审查代码变更：${parent.scope?.slice(0, 200) ?? ''}

完成审查后，除 ACTION 行外，还必须在输出的最后一行给出结构化结论：
REVIEW_RESULT: {"verdict":"pass"|"reject","summary":"一句话结论","issues":[{"severity":"error"|"warn"|"info","message":"问题描述"}]}
（verdict=pass 通过 / reject 打回；summary、issues 可省略。缺少该行将转人工评审。）`,
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
    if (parent.status !== 'in_review') return; // 父已被手动处理 -> 跳过

    const childMeta = child.metadata ? JSON.parse(child.metadata) as WorkUnitMetadata : {};
    const report = childMeta.reviewReport as
      | { approved: boolean; reason?: string; issues?: Array<{ severity: string; message: string }> }
      | undefined;

    if (!report) {
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

    if (report.approved) {
      await this.workUnitService.reviewPassed(parent.id);
    } else {
      const reason = report.reason
        ?? report.issues?.filter(i => i.severity === 'error').map(i => i.message).join('; ')
        ?? 'reviewer 拒绝';
      await this.workUnitService.reviewRejected(parent.id, reason);
    }
  }

  /** 向父 WU 所在频道发系统消息（转人工通知；形态同 waiting-input 提醒） */
  private async postSystemMessage(parent: WorkUnitData, content: string): Promise<void> {
    if (!parent.channelId) return;
    const anchor = await findAnchorMessage(parent.id, this.fileStore);
    const msg: ChannelMessageData = {
      id: randomUUID(),
      channelId: parent.channelId,
      authorType: 'agent',
      agentName: 'Studio',
      content,
      replyToId: anchor?.id ?? null,
      meta: '{}',
      workUnitId: parent.id,
      createdAt: new Date().toISOString(),
    };
    await this.fileStore.appendMessage(parent.channelId, msg);
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
