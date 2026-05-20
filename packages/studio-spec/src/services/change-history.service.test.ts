/**
 * ChangeHistoryService 单元测试
 * 
 * AC-010: 变更历史记录完整
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeHistoryService } from './change-history.service.js';
import type { ChangeRecord, ChangeLevel } from '../types/change.types.js';

const history = new ChangeHistoryService();

// 创建测试变更记录
function createRecord(
  specId: string,
  level: ChangeLevel,
  status: 'pending' | 'auto_approved' | 'approved' | 'rejected' | 'applied'
): ChangeRecord {
  return {
    id: `change-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    specId,
    level,
    changeTypes: [],
    summary: `测试变更 ${level}`,
    status,
    submittedBy: 'user-001',
    submittedAt: new Date(),
    oldVersion: { metadata: { id: specId } },
    newVersion: { metadata: { id: specId } },
  };
}

describe('ChangeHistoryService', () => {
  beforeEach(() => {
    history.clear();
  });

  // AC-010: 变更历史记录完整
  it('AC-010: should save and retrieve change history', async () => {
    const specId = 'spec-history-test';
    
    // 保存多个变更（确保时间戳不同）
    const record1 = createRecord(specId, 'L1', 'auto_approved');
    record1.submittedAt = new Date('2026-01-01T10:00:00');
    
    const record2 = createRecord(specId, 'L3', 'approved');
    record2.submittedAt = new Date('2026-01-01T11:00:00');
    
    const record3 = createRecord(specId, 'L4', 'pending');
    record3.submittedAt = new Date('2026-01-01T12:00:00');
    
    history.save(record1);
    history.save(record2);
    history.save(record3);
    
    // 查询历史
    const records = history.getHistory(specId);
    
    expect(records.length).toBe(3);
    // 验证按时间倒序（最新的在最前面）
    expect(records[0].level).toBe('L4');
    expect(records[1].level).toBe('L3');
    expect(records[2].level).toBe('L1');
  });

  // AC-010b: 获取单个变更记录
  it('AC-010b: should get single change record', () => {
    const specId = 'spec-single-test';
    const record = createRecord(specId, 'L2', 'auto_approved');
    
    history.save(record);
    
    const found = history.get(record.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(record.id);
    expect(found?.level).toBe('L2');
  });

  // AC-010c: 变更统计
  it('AC-010c: should calculate change stats', () => {
    const specId = 'spec-stats-test';
    
    history.save(createRecord(specId, 'L1', 'auto_approved'));
    history.save(createRecord(specId, 'L1', 'applied'));
    history.save(createRecord(specId, 'L2', 'auto_approved'));
    history.save(createRecord(specId, 'L3', 'approved'));
    history.save(createRecord(specId, 'L3', 'rejected'));
    history.save(createRecord(specId, 'L4', 'pending'));
    
    const stats = history.getStats(specId);
    
    expect(stats.total).toBe(6);
    expect(stats.byLevel.L1).toBe(2);
    expect(stats.byLevel.L2).toBe(1);
    expect(stats.byLevel.L3).toBe(2);
    expect(stats.byLevel.L4).toBe(1);
    
    expect(stats.byStatus.auto_approved).toBe(2);
    expect(stats.byStatus.applied).toBe(1);
    expect(stats.byStatus.approved).toBe(1);
    expect(stats.byStatus.rejected).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
  });

  // AC-010d: 最近变更列表
  it('AC-010d: should return recent changes', async () => {
    const specId = 'spec-recent-test';
    
    // 保存 15 个变更
    for (let i = 0; i < 15; i++) {
      history.save(createRecord(specId, 'L1', 'applied'));
      await new Promise(r => setTimeout(r, 5));
    }
    
    const stats = history.getStats(specId);
    
    expect(stats.total).toBe(15);
    expect(stats.recentChanges.length).toBe(10); // 只返回最近 10 条
  });

  // AC-010e: 清理历史
  it('AC-010e: should clear history', () => {
    const specId = 'spec-clear-test';
    
    history.save(createRecord(specId, 'L1', 'applied'));
    expect(history.getHistory(specId).length).toBe(1);
    
    history.clear(specId);
    expect(history.getHistory(specId).length).toBe(0);
  });

  // AC-010f: 导出/导入
  it('AC-010f: should export and import history', () => {
    const specId = 'spec-export-test';
    
    history.save(createRecord(specId, 'L1', 'applied'));
    history.save(createRecord(specId, 'L3', 'approved'));
    
    const exported = history.export(specId);
    expect(exported).toContain('L1');
    expect(exported).toContain('L3');
    
    history.clear(specId);
    expect(history.getHistory(specId).length).toBe(0);
    
    const count = history.import(specId, exported);
    expect(count).toBe(2);
    
    const records = history.getHistory(specId);
    expect(records.length).toBe(2);
  });

  // AC-010g: 不存在的 Spec 返回空数组
  it('AC-010g: should return empty for non-existent spec', () => {
    const records = history.getHistory('non-existent-spec');
    expect(records.length).toBe(0);
    
    const stats = history.getStats('non-existent-spec');
    expect(stats.total).toBe(0);
  });

  // AC-010h: 不存在的变更返回 undefined
  it('AC-010h: should return undefined for non-existent change', () => {
    const record = history.get('non-existent-id');
    expect(record).toBeUndefined();
  });
});