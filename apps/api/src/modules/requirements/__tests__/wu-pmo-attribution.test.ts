/**
 * wu-pmo-attribution（2026-08 归因统一）：创建期 PMO 归因戳纯解析测试
 *
 * 覆盖：canonical pmoId / legacy ownershipProjectId 同位读 / 同级内 pmoId 优先 /
 *       坏 JSON · null · undefined · 非字符串 · 空串容错。
 */
import { describe, it, expect } from 'vitest';
import { parseWuPmoId } from '../wu-pmo-attribution.js';

describe('parseWuPmoId', () => {
  it('canonical metadata.pmoId 命中', () => {
    expect(parseWuPmoId(JSON.stringify({ pmoId: 'proj-1' }))).toBe('proj-1');
  });

  it('legacy metadata.ownershipProjectId 同位命中', () => {
    expect(parseWuPmoId(JSON.stringify({ ownershipProjectId: 'proj-legacy' }))).toBe('proj-legacy');
  });

  it('同级内 pmoId 优先于 ownershipProjectId', () => {
    expect(
      parseWuPmoId(JSON.stringify({ pmoId: 'proj-1', ownershipProjectId: 'proj-legacy' })),
    ).toBe('proj-1');
  });

  it('pmoId 为空串时回落 legacy ownershipProjectId', () => {
    expect(
      parseWuPmoId(JSON.stringify({ pmoId: '', ownershipProjectId: 'proj-legacy' })),
    ).toBe('proj-legacy');
  });

  it('坏 JSON / null / undefined / 无字段 / 非字符串 / 空串 → null', () => {
    expect(parseWuPmoId('{broken')).toBeNull();
    expect(parseWuPmoId(null)).toBeNull();
    expect(parseWuPmoId(undefined)).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ title: 'x' }))).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ pmoId: 42 }))).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ pmoId: '' }))).toBeNull();
    expect(parseWuPmoId(JSON.stringify({ ownershipProjectId: '' }))).toBeNull();
  });

  it('pmoProjectId 不属于创建期戳口径（不命中）', () => {
    expect(parseWuPmoId(JSON.stringify({ pmoProjectId: 'proj-1' }))).toBeNull();
  });
});
