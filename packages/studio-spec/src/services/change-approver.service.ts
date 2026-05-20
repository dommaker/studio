/**
 * 变更审批服务
 * 
 * SP-002: Spec 变更分级流程（L1-L4）
 * 
 * 负责：
 * 1. 提交变更（自动判定级别）
 * 2. 处理审批请求
 * 3. 执行审批流程
 */

import {
  SubmitChangeInput,
  SubmitChangeResult,
  ApproveChangeInput,
  ChangeLevel,
  ChangeType,
  ChangeRecord,
  ApprovalProcess,
  SpecContent,
} from '../types/change.types.js';

import { ChangeAnalyzerService, changeAnalyzerService } from './change-analyzer.service.js';
import { logger } from '@dommaker/studio-shared';
import { PrismaClient } from '@prisma/client';

/**
 * 审批流程配置
 */
const APPROVAL_CONFIG: Record<ChangeLevel, {
  autoApprove: boolean;
  requiresApproval: boolean;
  requiredApprovers: number;
}> = {
  L1: { autoApprove: true, requiresApproval: false, requiredApprovers: 0 },
  L2: { autoApprove: true, requiresApproval: false, requiredApprovers: 0 }, // GateChecker 自动
  L3: { autoApprove: false, requiresApproval: true, requiredApprovers: 1 },
  L4: { autoApprove: false, requiresApproval: true, requiredApprovers: 3 },
};

const prisma = new PrismaClient();


export class ChangeApproverService {
  private analyzer: ChangeAnalyzerService;

  constructor(analyzer?: ChangeAnalyzerService) {
    this.analyzer = analyzer || changeAnalyzerService;
  }

  /**
   * 提交变更
   */
  async submit(input: SubmitChangeInput): Promise<SubmitChangeResult> {
    const { specId, changeContent, changeNote, submittedBy } = input;

    logger.info(`[ChangeApprover] 提交变更: ${specId} by ${submittedBy}`);

    // 1. 获取旧版本（从数据库）
    const oldVersion = await this.getOldVersion(specId);

    // 2. 分析变更级别
    const analysis = await this.analyzer.analyze({
      specId,
      oldVersion,
      newVersion: changeContent,
    });

    // 3. 确定审批流程
    const config = APPROVAL_CONFIG[analysis.level];
    const approvalProcess = analysis.recommendedApproval;

    // 4. 持久化到 SpecChangeRequest 表
    const status = config.autoApprove ? 'auto_approved' : 'pending';
    const record = await prisma.specChangeRequest.create({
      data: {
        specId,
        level: analysis.level,
        changeTypes: JSON.stringify(analysis.changeTypes),
        summary: analysis.summary,
        status,
        submittedBy,
        metadata: JSON.stringify({
          oldVersion,
          newVersion: changeContent,
          changeNote,
        }),
      },
    });

    // 5. 自动审批处理
    if (config.autoApprove) {
      await this.autoApprove(record.id);
    }

    // 6. 返回结果
    const resultStatus = config.autoApprove
      ? 'auto_approved'
      : (analysis.level === 'L4' ? 'needs_meeting' : 'pending_approval');

    logger.info(`[ChangeApprover] 变更提交完成: ${record.id}, 状态: ${resultStatus}`);

    return {
      changeId: record.id,
      level: analysis.level,
      changeTypes: analysis.changeTypes,
      status: resultStatus,
      approvalProcess,
    };
  }

  /**
   * 审批变更
   */
  async approve(input: ApproveChangeInput): Promise<{
    success: boolean;
    status: 'approved' | 'rejected' | 'pending_more_approvers';
    message: string;
  }> {
    const { changeId, approvedBy, approved, comment } = input;

    const record = await prisma.specChangeRequest.findUnique({ where: { id: changeId } });
    if (!record) {
      throw new Error(`变更记录不存在: ${changeId}`);
    }

    if (record.status !== 'pending') {
      throw new Error(`变更已处理: ${record.status}`);
    }

    logger.info(`[ChangeApprover] 审批变更: ${changeId} by ${approvedBy}, 结果: ${approved}`);

    const config = APPROVAL_CONFIG[record.level as ChangeLevel];
    const metadata = JSON.parse(record.metadata || '{}');
    const approvers = (metadata.approvers as string[]) || [];

    // 如果拒绝
    if (!approved) {
      await prisma.specChangeRequest.update({
        where: { id: changeId },
        data: { status: 'rejected', metadata: JSON.stringify({ ...metadata, rejectedBy: approvedBy, rejectionComment: comment }) },
      });

      return {
        success: false,
        status: 'rejected',
        message: comment || '变更被拒绝',
      };
    }

    // L1/L2 不应该到达这里（已自动审批）
    if (record.level === 'L1' || record.level === 'L2') {
      throw new Error(`L1/L2 变更已自动审批，无需人工审批`);
    }

    // L3: 单人审批即可通过
    if (record.level === 'L3') {
      await prisma.specChangeRequest.update({
        where: { id: changeId },
        data: { status: 'approved', metadata: JSON.stringify({ ...metadata, approvers: [approvedBy], approvedBy }) },
      });

      return {
        success: true,
        status: 'approved',
        message: '变更已批准',
      };
    }

    // L4: 需要多人审批
    if (record.level === 'L4') {
      if (approvers.includes(approvedBy)) {
        throw new Error(`${approvedBy} 已审批过此变更`);
      }

      approvers.push(approvedBy);
      const currentApprovals = approvers.length;

      if (currentApprovals >= config.requiredApprovers) {
        await prisma.specChangeRequest.update({
          where: { id: changeId },
          data: { status: 'approved', metadata: JSON.stringify({ ...metadata, approvers, approvedBy }) },
        });

        return {
          success: true,
          status: 'approved',
          message: `已获得 ${config.requiredApprovers} 人批准`,
        };
      } else {
        await prisma.specChangeRequest.update({
          where: { id: changeId },
          data: { metadata: JSON.stringify({ ...metadata, approvers }) },
        });

        return {
          success: true,
          status: 'pending_more_approvers',
          message: `已批准，还需 ${config.requiredApprovers - currentApprovals} 人`,
        };
      }
    }

    throw new Error(`未知的审批级别: ${record.level}`);
  }

  /**
   * 应用变更（执行实际的 Spec 更新）
   */
  async apply(changeId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    const record = await prisma.specChangeRequest.findUnique({ where: { id: changeId } });
    if (!record) {
      throw new Error(`变更记录不存在: ${changeId}`);
    }

    if (record.status !== 'approved' && record.status !== 'auto_approved') {
      throw new Error(`变更未批准: ${record.status}`);
    }

    logger.info(`[ChangeApprover] 应用变更: ${changeId}`);

    // 更新状态为 applied
    await prisma.specChangeRequest.update({
      where: { id: changeId },
      data: { status: 'applied', appliedAt: new Date() },
    });

    return {
      success: true,
      message: `Spec ${record.specId} 已更新`,
    };
  }

  /**
   * 获取变更记录
   */
  async get(changeId: string): Promise<ChangeRecord | null> {
    const record = await prisma.specChangeRequest.findUnique({ where: { id: changeId } });
    if (!record) return null;
    return this.toChangeRecord(record);
  }

  /**
   * 获取 Spec 的所有变更记录
   */
  async list(specId: string): Promise<ChangeRecord[]> {
    const records = await prisma.specChangeRequest.findMany({
      where: { specId },
      orderBy: { submittedAt: 'desc' },
    });
    return records.map(r => this.toChangeRecord(r));
  }

  /**
   * DB 记录转 ChangeRecord
   */
  private toChangeRecord(record: {
    id: string; specId: string; level: string; changeTypes: string;
    summary: string; status: string; submittedBy: string; submittedAt: Date;
    appliedAt: Date | null; metadata: unknown;
  }): ChangeRecord {
    const metadata = JSON.parse(record.metadata || '{}');
    return {
      id: record.id,
      specId: record.specId,
      level: record.level as ChangeLevel,
      changeTypes: JSON.parse(record.changeTypes || '[]') as ChangeType[],
      summary: record.summary,
      status: record.status as ChangeRecord['status'],
      submittedBy: record.submittedBy,
      submittedAt: record.submittedAt,
      oldVersion: metadata.oldVersion as SpecContent,
      newVersion: metadata.newVersion as SpecContent,
      approvedBy: metadata.approvedBy as string | undefined,
      approvers: metadata.approvers as string[] | undefined,
    };
  }

  /**
   * 自动审批处理
   */
  private async autoApprove(changeId: string): Promise<void> {
    // L1/L2 自动通过，后续可接入 GateChecker 验证
    logger.info(`[ChangeApprover] 自动审批: ${changeId}`);
  }

  /**
   * 获取旧版本 Spec
   */
  private async getOldVersion(specId: string): Promise<SpecContent> {
    // 1. 从 DB 中获取最近 applied 的版本
    const appliedRecord = await prisma.specChangeRequest.findFirst({
      where: { specId, status: 'applied' },
      orderBy: { appliedAt: 'desc' },
    });

    if (appliedRecord) {
      const metadata = JSON.parse(appliedRecord.metadata || '{}');
      if (metadata.newVersion) return metadata.newVersion as SpecContent;
    }

    // 2. 获取最近的 approved 版本
    const approvedRecord = await prisma.specChangeRequest.findFirst({
      where: { specId, status: { in: ['approved', 'auto_approved'] } },
      orderBy: { submittedAt: 'desc' },
    });

    if (approvedRecord) {
      const metadata = JSON.parse(approvedRecord.metadata || '{}');
      if (metadata.newVersion) return metadata.newVersion as SpecContent;
    }

    // 3. 没有历史版本，返回空 Spec
    return {
      metadata: {
        id: specId,
        title: '',
        status: 'draft',
      },
    };
  }
}

// 导出单例
export const changeApproverService = new ChangeApproverService();