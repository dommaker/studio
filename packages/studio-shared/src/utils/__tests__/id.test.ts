/**
 * generateId 单元测试（工单42：统一 ID 生成工具）。
 *
 * 覆盖：前缀拼接、格式 `${prefix}_${ts}_${rand}`、随机段长度、多次调用唯一性。
 */
import { describe, it, expect } from 'vitest';
import { generateId } from '../id';

describe('generateId', () => {
  it('生成 `${prefix}_${Date.now()}_${rand}` 格式', () => {
    const id = generateId('doc');
    const parts = id.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('doc');
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(parts[2]).toMatch(/^[0-9a-z]+$/);
  });

  it('随机段为 toString(36).substring(2, 9)，长度 7', () => {
    expect(generateId('x').split('_')[2]).toHaveLength(7);
  });

  it('多次调用生成不同 ID', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('t')));
    expect(ids.size).toBe(100);
  });
});
