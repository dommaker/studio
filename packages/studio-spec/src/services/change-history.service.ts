/**
 * 变更历史服务
 * 
 * SP-002: Spec 变更分级流程（L1-L4）
 * AC-010: 变更历史记录完整
 * 
 * 负责：
 * 1. 存储变更记录（持久化）
 * 2. 查询变更历史
 * 3. 变更统计
 */

import {
  ChangeRecord,
  ChangeLevel,
} from '../types/change.types.js';

import { logger } from '@dommaker/studio-shared';

/**
 * 内存存储（临时，后续接入 Prisma）
 */
const historyStore: Map<string, ChangeRecord[]> = new Map();

export class ChangeHistoryService {
  /**
   * 保存变更记录
   */
  save(record: ChangeRecord): void {
    const specId = record.specId;
    
    if (!historyStore.has(specId)) {
      historyStore.set(specId, []);
    }
    
    const records = historyStore.get(specId)!;
    records.push(record);
    
    logger.info(`[ChangeHistory] 保存变更: ${record.id} -> ${specId}`);
  }

  /**
   * 获取 Spec 的变更历史
   */
  getHistory(specId: string): ChangeRecord[] {
    const records = historyStore.get(specId) || [];
    return records.sort((a, b) => 
      b.submittedAt.getTime() - a.submittedAt.getTime()
    );
  }

  /**
   * 获取单个变更记录
   */
  get(changeId: string): ChangeRecord | undefined {
    for (const records of historyStore.values()) {
      const record = records.find(r => r.id === changeId);
      if (record) return record;
    }
    return undefined;
  }

  /**
   * 获取变更统计
   */
  getStats(specId: string): {
    total: number;
    byLevel: Record<ChangeLevel, number>;
    byStatus: Record<string, number>;
    recentChanges: ChangeRecord[];
  } {
    const records = this.getHistory(specId);
    
    const byLevel: Record<ChangeLevel, number> = {
      L1: 0,
      L2: 0,
      L3: 0,
      L4: 0,
    };
    
    const byStatus: Record<string, number> = {
      pending: 0,
      auto_approved: 0,
      approved: 0,
      rejected: 0,
      applied: 0,
    };
    
    for (const record of records) {
      byLevel[record.level]++;
      byStatus[record.status]++;
    }
    
    return {
      total: records.length,
      byLevel,
      byStatus,
      recentChanges: records.slice(0, 10),
    };
  }

  /**
   * 清理测试数据
   */
  clear(specId?: string): void {
    if (specId) {
      historyStore.delete(specId);
      logger.info(`[ChangeHistory] 清理: ${specId}`);
    } else {
      historyStore.clear();
      logger.info(`[ChangeHistory] 清理全部`);
    }
  }

  /**
   * 导出变更历史（用于备份/迁移）
   */
  export(specId: string): string {
    const records = this.getHistory(specId);
    return JSON.stringify(records, null, 2);
  }

  /**
   * 导入变更历史（用于恢复）
   */
  import(specId: string, data: string): number {
    const records: ChangeRecord[] = JSON.parse(data);
    
    // 转换日期
    for (const record of records) {
      record.submittedAt = new Date(record.submittedAt);
      if (record.approvedAt) record.approvedAt = new Date(record.approvedAt);
      if (record.appliedAt) record.appliedAt = new Date(record.appliedAt);
    }
    
    historyStore.set(specId, records);
    logger.info(`[ChangeHistory] 导入: ${specId} (${records.length} 条)`);
    
    return records.length;
  }
}

// 导出单例
export const changeHistoryService = new ChangeHistoryService();