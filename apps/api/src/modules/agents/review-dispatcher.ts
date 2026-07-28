/**
 * ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派
 *
 * 订阅 workunit.status_changed：
 *   路径 A：父 WU -> in_review -> 找频道内 reviewer 角色 -> 创建 review 子 WU（绕过 DelegationGate）
 *   路径 B：子 WU（type=review）-> done -> 解析 metadata.reviewReport -> 父 WU reviewPassed/reviewRejected
 *     （reviewReport 由 reviewer 的 AgentLoop 在子 WU complete 时解析 REVIEW_RESULT 写入；
 *       缺失/无法解析 -> 不默认拒绝，频道发系统消息转人工，父 WU 保持 in_review）
 *
 * 设计决策（design.md §1.2）：
 *   D5: 状态机驱动，不走 agent DELEGATE 协议
 *   D6: 绕过 DelegationGate（系统代派不是 agent 主动 DELEGATE）
 *   D7: 旧 reviewAgent.review() 已删除（2026-07-28，逾期收尾）；review-agent.service 仅保留 reviewDiff() 供 /review/diff 管理端点
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

  /** 检查频道是否有 reviewer 角色（description 含 'reviewer'） */
  private async findReviewerInChannel(channelId: string): Promise<AgentProfileData | null> {
    const channel = await this.fileStore.getChannel(channelId);
    // P0 修复：安全解析 members —— 损坏 JSON / 非数组 / 双重编码一律按无成员处理
    // （此前裸 JSON.parse 只对语法错误兜底，非数组值会让派发静默跳过）
    const memberIds = parseChannels(channel?.members);
    if (memberIds.length === 0) return null;

    const allProfiles = await this.fileStore.listProfiles({ status: 'active' });
    const members = allProfiles.filter(p => memberIds.includes(p.id) && p.name !== 'studio');
    if (members.length === 0) return null;

    const reviewer = members.find(p =>
      p.description?.toLowerCase().includes('reviewer'),
    );
    return reviewer ?? null;
  }

  /** 父 WU 进入 in_review 时的处理 */
  private async handleParentInReview(parent: WorkUnitData): Promise<void> {
    if (!parent.channelId) return;

    const reviewer = await this.findReviewerInChannel(parent.channelId);
    if (!reviewer) return; // 无 reviewer 角色 -> 前端提醒（AC-2.4），不卡流程

    // 同父唯一性校验：已有未完结 review 子 WU -> 跳过
    const snapshots = await this.fileStore.getIndex();
    const existingReview = snapshots.some(s =>
      s.parentId === parent.id
      && s.type === 'review'
      && s.status !== 'done'
      && s.status !== 'closed',
    );
    if (existingReview) return;

    await this.createReviewWorkUnit(parent, reviewer);
  }

  /** 创建 review 子 WU（绕过 DelegationGate，design.md D6） */
  private async createReviewWorkUnit(parent: WorkUnitData, reviewer: AgentProfileData): Promise<WorkUnitData> {
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
        chain: [...parentCollab.chain, reviewer.id],
        delegatedBy: { profileId: parent.assigneeId ?? '', workUnitId: parent.id },
        delegationCount: 0,
      },
    };

    const child = await this.workUnitService.create({
      type: 'review',
      // P0 修复（reviewReport 回传断链）：scope 写入 REVIEW_RESULT 输出约定 ——
      // reviewer 的 AgentLoop complete 时据此解析结构化结论写入 metadata.reviewReport
      scope: `审查代码变更：${parent.scope?.slice(0, 200) ?? ''}

完成审查后，除 ACTION 行外，还必须在输出的最后一行给出结构化结论：
REVIEW_RESULT: {"verdict":"pass"|"reject","summary":"一句话结论","issues":[{"severity":"error"|"warn"|"info","message":"问题描述"}]}
（verdict=pass 通过 / reject 打回；summary、issues 可省略。缺少该行将转人工评审。）`,
      assigneeId: reviewer.id,
      status: 'unassigned',
      channelId: parent.channelId,
      parentId: parent.id,
      workspaceId: parent.workspaceId ?? null,
      reqId: typeof parentMeta.reqId === 'string' ? parentMeta.reqId : null,
      metadata: childMeta,
    });

    logger.info('[ReviewDispatcher] Created review child WU', {
      parentId: parent.id,
      childId: child.id,
      reviewer: reviewer.name,
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
