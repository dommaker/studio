// Contract test: alertGrouping — #398 监控页告警按归一化 message 签名分组（spec §7.3，纯前端不动探针口径）
import { describe, it, expect } from 'vitest';
import { groupAlertsBySignature, type AlertItem } from '../alertGrouping';

const at = (iso: string) => iso;

describe('groupAlertsBySignature', () => {
  it('数字不同的同类 message 归并为一组：count 累计、文案取最近一条原文、latestAt 取最大', () => {
    const alerts: AlertItem[] = [
      { level: 'warning', message: '未认领池滞留：最老任务已滞留 5h', createdAt: at('2026-08-29T01:00:00Z') },
      { level: 'warning', message: '未认领池滞留：最老任务已滞留 7h', createdAt: at('2026-08-29T03:00:00Z') },
      { level: 'warning', message: '未认领池滞留：最老任务已滞留 6h', createdAt: at('2026-08-29T02:00:00Z') },
    ];
    const groups = groupAlertsBySignature(alerts);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].message).toBe('未认领池滞留：最老任务已滞留 7h');
    expect(groups[0].latestAt).toBe('2026-08-29T03:00:00Z');
    expect(groups[0].level).toBe('warning');
  });

  it('含 id/hex 片段的 message 也按签名归并', () => {
    const alerts: AlertItem[] = [
      { level: 'critical', message: '执行 loop 失联：实例 1a2b3c4d 心跳过期', createdAt: at('2026-08-29T01:00:00Z') },
      { level: 'critical', message: '执行 loop 失联：实例 9f8e7d6c 心跳过期', createdAt: at('2026-08-29T02:00:00Z') },
    ];
    const groups = groupAlertsBySignature(alerts);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
  });

  it('同签名不同级别 → 两组（级别 pill 各自展示）', () => {
    const alerts: AlertItem[] = [
      { level: 'warning', message: '队列深度 12', createdAt: at('2026-08-29T01:00:00Z') },
      { level: 'critical', message: '队列深度 40', createdAt: at('2026-08-29T02:00:00Z') },
    ];
    const groups = groupAlertsBySignature(alerts);
    expect(groups).toHaveLength(2);
  });

  it('排序：critical 优先，同级按 latestAt 降序', () => {
    const alerts: AlertItem[] = [
      { level: 'warning', message: 'w-新', createdAt: at('2026-08-29T05:00:00Z') },
      { level: 'critical', message: 'c-旧', createdAt: at('2026-08-29T01:00:00Z') },
      { level: 'warning', message: 'w-旧', createdAt: at('2026-08-29T02:00:00Z') },
    ];
    const groups = groupAlertsBySignature(alerts);
    expect(groups.map(g => g.message)).toEqual(['c-旧', 'w-新', 'w-旧']);
  });

  it('空数组 → 空；缺 createdAt 不炸（latestAt 为 undefined）', () => {
    expect(groupAlertsBySignature([])).toEqual([]);
    const groups = groupAlertsBySignature([{ level: 'warning', message: '无时间' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].latestAt).toBeUndefined();
    expect(groups[0].count).toBe(1);
  });

  it('不同文案不互相归并', () => {
    const alerts: AlertItem[] = [
      { level: 'warning', message: '滞留 5h', createdAt: at('2026-08-29T01:00:00Z') },
      { level: 'warning', message: '心跳过期 5h', createdAt: at('2026-08-29T02:00:00Z') },
    ];
    expect(groupAlertsBySignature(alerts)).toHaveLength(2);
  });
});
