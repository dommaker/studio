/**
 * wu-pmo-attribution（2026-08 归因统一）：创建期 PMO 归因戳纯解析测试
 *
 * 覆盖：canonical pmoId / 坏 JSON · null · undefined · 非字符串 · 空串容错。
 * （legacy ownershipProjectId 同位读已随架构精简刀6 删除，生产存量实测为零。）
 */
import { describe, it, expect } from 'vitest';
import { parseWuPmoId } from '../wu-pmo-attribution.js';

describe('parseWuPmoId', () => {
  it('canonical metadata.pmoId 命中', () => {
    expect(parseWuPmoId(JSON.stringify({ pmoId: 'proj-1' }))).toBe('proj-1');
  });

  it('坏 JSON / null / undefined / 无字段 / 非字符串 / 空串 → null', () => {
    expect(parseWuPmoId('{broken')).toBeNull();
    expect(parseWuPmoId(null)).toBeNull();
    expect(parseWuPmoId(undefined)).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ title: 'x' }))).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ pmoId: 42 }))).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ pmoId: '' }))).toBeNull();
  });

  it('pmoProjectId 不属于创建期戳口径（不命中）', () => {
    expect(parseWuPmoId(JSON.stringify({ pmoProjectId: 'proj-1' }))).toBeNull();
  });
});
