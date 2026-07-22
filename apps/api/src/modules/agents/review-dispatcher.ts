/**
 * ReviewDispatcher - AC-4.1 ~ AC-4.5: 状态机驱动的 review 系统代派
 *
 * 订阅 workunit.status_changed：
 *   路径 A：父 WU -> in_review -> 找频道内 reviewer 角色 -> 创建 review 子 WU（绕过 DelegationGate）
 *   路径 B：子 WU（type=review）-> done -> 解析 metadata.reviewReport -> 父 WU reviewPassed/reviewRejected
 *
 * 设计决策（design.md §1.2）：
 *   D5: 状态机驱动，不走 agent DELEGATE 协议
 *   D6: 绕过 DelegationGate（系统代派不是 agent 主动 DELEGATE）
 *   D7: 旧 reviewAgent.review() 保留至 AC Group 7
 */

import { eventBus, logger, type FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { readCollab } from '../workunit/delegation-gate.js';

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
    if (!channel?.members) return null;
    let memberIds: string[] = [];
    try {
      memberIds = JSON.parse(channel.members);
    } catch {
      return null;
    }
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
      scope: `审查代码变更：${parent.scope?.slice(0, 200) ?? ''}`,
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
      // reviewer 输出格式异常 -> 默认拒绝（AC-4.5 边界）
      await this.workUnitService.reviewRejected(parent.id, 'reviewer 输出格式异常，无法解析审查结论');
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
