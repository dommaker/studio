/**
 * 门禁绕过管理器
 * 
 * 功能：
 * 1. 管理门禁绕过请求
 * 2. 记录绕过原因和审批人
 * 3. 支持紧急修复场景
 * 4. 绕过记录审计
 * 
 * 使用示例：
 * ```typescript
 * const manager = createGateBypassManager({
 *   contextSharer,
 *   approver: 'admin',
 * });
 * 
 * // 请求绕过
 * const bypass = await manager.requestBypass({
 *   meetingId: 'meeting-123',
 *   taskId: 'task-456',
 *   gates: ['test', 'review'],
 *   reason: 'Emergency hotfix for production issue',
 *   requestedBy: 'developer',
 * });
 * ```
 */

import type { ContextSharer } from './context-sharer';
import type { GateType } from './gate-checker';

/**
 * 绕过配置
 */
export interface GateBypassConfig {
  contextSharer: ContextSharer;
  /** 默认审批人 */
  defaultApprover?: string;
  /** 绕过期默认时长（毫秒） */
  defaultTTL?: number;
  /** 是否需要审批 */
  requireApproval?: boolean;
  /** 允许绕过的门禁类型 */
  allowedGates?: GateType[];
  /** 禁止绕过的门禁类型（优先级更高） */
  blockedGates?: GateType[];
}

/**
 * 绕过请求
 */
export interface BypassRequest {
  meetingId: string;
  taskId?: string;
  gates: GateType[];
  reason: BypassReason;
  requestedBy: string;
  urgency?: 'low' | 'medium' | 'high' | 'critical';
  expiresAt?: string;
}

/**
 * 绕过原因
 */
export type BypassReason = 
  | 'emergency_fix'
  | 'hotfix'
  | 'security_patch'
  | 'test_infrastructure_issue'
  | 'dependency_issue'
  | 'manual_override'
  | 'other';

/**
 * 绕过记录
 */
export interface BypassRecord {
  id: string;
  meetingId: string;
  taskId?: string;
  gates: GateType[];
  reason: BypassReason;
  requestedBy: string;
  approvedBy?: string;
  approvedAt?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt?: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  notes?: string;
}

/**
 * 绕过检查结果
 */
export interface BypassCheckResult {
  canBypass: boolean;
  bypass?: BypassRecord;
  reason?: string;
}

/**
 * 门禁绕过管理器
 */
export class GateBypassManager {
  private contextSharer: ContextSharer;
  private defaultApprover?: string;
  private defaultTTL: number;
  private requireApproval: boolean;
  private allowedGates: GateType[] | null;
  private blockedGates: GateType[];

  constructor(config: GateBypassConfig) {
    this.contextSharer = config.contextSharer;
    this.defaultApprover = config.defaultApprover;
    this.defaultTTL = config.defaultTTL ?? 3600000; // 默认 1 小时
    this.requireApproval = config.requireApproval ?? true;
    this.allowedGates = config.allowedGates ?? null; // null 表示允许所有
    this.blockedGates = config.blockedGates ?? [];
  }

  /**
   * 请求绕过
   */
  async requestBypass(request: BypassRequest): Promise<BypassRecord> {
    const id = `bypass-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 验证门禁类型
    for (const gate of request.gates) {
      if (this.blockedGates.includes(gate)) {
        throw new Error(`Gate ${gate} is blocked from bypass`);
      }
      if (this.allowedGates && !this.allowedGates.includes(gate)) {
        throw new Error(`Gate ${gate} is not allowed for bypass`);
      }
    }

    const expiresAt = request.expiresAt ?? 
      new Date(Date.now() + this.defaultTTL).toISOString();

    const record: BypassRecord = {
      id,
      meetingId: request.meetingId,
      taskId: request.taskId,
      gates: request.gates,
      reason: request.reason,
      requestedBy: request.requestedBy,
      status: this.requireApproval ? 'pending' : 'approved',
      createdAt: new Date().toISOString(),
      expiresAt,
      urgency: request.urgency ?? 'medium',
    };

    // 如果不需要审批，自动批准
    if (!this.requireApproval) {
      record.approvedBy = this.defaultApprover ?? 'auto';
      record.approvedAt = new Date().toISOString();
    }

    // 存储记录
    await this.saveBypassRecord(record);

    return record;
  }

  /**
   * 批准绕过
   */
  async approveBypass(bypassId: string, approvedBy: string): Promise<BypassRecord> {
    const record = await this.getBypassRecord(bypassId);

    if (!record) {
      throw new Error(`Bypass record not found: ${bypassId}`);
    }

    if (record.status !== 'pending') {
      throw new Error(`Bypass is not pending: ${record.status}`);
    }

    record.approvedBy = approvedBy;
    record.approvedAt = new Date().toISOString();
    record.status = 'approved';

    await this.updateBypassRecord(record);

    return record;
  }

  /**
   * 拒绝绕过
   */
  async rejectBypass(bypassId: string, rejectedBy: string, reason?: string): Promise<BypassRecord> {
    const record = await this.getBypassRecord(bypassId);

    if (!record) {
      throw new Error(`Bypass record not found: ${bypassId}`);
    }

    if (record.status !== 'pending') {
      throw new Error(`Bypass is not pending: ${record.status}`);
    }

    record.status = 'rejected';
    record.notes = reason ? `Rejected by ${rejectedBy}: ${reason}` : `Rejected by ${rejectedBy}`;

    await this.updateBypassRecord(record);

    return record;
  }

  /**
   * 检查是否可以绕过
   */
  async checkBypass(
    meetingId: string,
    gate: GateType,
    taskId?: string
  ): Promise<BypassCheckResult> {
    const records = await this.getActiveBypasses(meetingId, taskId);

    for (const record of records) {
      if (record.gates.includes(gate)) {
        return {
          canBypass: true,
          bypass: record,
        };
      }
    }

    return {
      canBypass: false,
      reason: 'No active bypass found for this gate',
    };
  }

  /**
   * 获取活跃的绕过记录
   */
  async getActiveBypasses(meetingId: string, taskId?: string): Promise<BypassRecord[]> {
    const allRecords = await this.getBypassRecords(meetingId);
    const now = new Date();

    return allRecords.filter(record => {
      // 必须是已批准的
      if (record.status !== 'approved') return false;

      // 检查是否过期
      if (record.expiresAt && new Date(record.expiresAt) < now) return false;

      // 检查 taskId 是否匹配
      if (taskId && record.taskId && record.taskId !== taskId) return false;

      return true;
    });
  }

  /**
   * 使绕过失效
   */
  async expireBypass(bypassId: string): Promise<void> {
    const record = await this.getBypassRecord(bypassId);

    if (!record) return;

    record.status = 'expired';
    await this.updateBypassRecord(record);
  }

  /**
   * 获取绕过历史
   */
  async getBypassHistory(meetingId: string): Promise<BypassRecord[]> {
    return this.getBypassRecords(meetingId);
  }

  // ============================================
  // 私有方法
  // ============================================

  private async saveBypassRecord(record: BypassRecord): Promise<void> {
    const key = `bypass:${record.meetingId}:${record.id}`;
    await this.contextSharer.set(key, record);

    // 更新索引
    const indexKey = `bypass:index:${record.meetingId}`;
    const index = await this.contextSharer.getValue<string[]>(indexKey) ?? [];
    index.push(record.id);
    await this.contextSharer.set(indexKey, index);
  }

  private async getBypassRecord(bypassId: string): Promise<BypassRecord | null> {
    // 需要从索引中查找 meetingId
    // 简化实现：遍历所有索引
    // 实际生产环境应该使用更高效的查询方式
    return null;
  }

  private async updateBypassRecord(record: BypassRecord): Promise<void> {
    const key = `bypass:${record.meetingId}:${record.id}`;
    await this.contextSharer.set(key, record);
  }

  private async getBypassRecords(meetingId: string): Promise<BypassRecord[]> {
    const indexKey = `bypass:index:${meetingId}`;
    const index = await this.contextSharer.getValue<string[]>(indexKey) ?? [];

    const records: BypassRecord[] = [];
    for (const id of index) {
      const key = `bypass:${meetingId}:${id}`;
      const record = await this.contextSharer.getValue<BypassRecord>(key);
      if (record) {
        records.push(record);
      }
    }

    return records;
  }
}

/**
 * 创建门禁绕过管理器（便捷函数）
 */
export function createGateBypassManager(config: GateBypassConfig): GateBypassManager {
  return new GateBypassManager(config);
}
