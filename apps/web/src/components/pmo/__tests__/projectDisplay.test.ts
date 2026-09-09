// projectDisplay 词表契约（#472）：项目状态词 / 交付策略文案唯一出口——
// ProjectCard / ProjectDetailPage MetaStrip / DeliveryPanel / PmoNumberBadge 四处同源，禁止再写三元表达式
import { describe, expect, it } from 'vitest';
import { DELIVERY_POLICY_LABELS, PROJECT_STATUS_COLORS, PROJECT_STATUS_LABELS } from '../projectDisplay';

describe('PROJECT_STATUS_LABELS', () => {
  it('项目状态 → 中文词（与 #399 §8.3 项目阶段词 讨论/开发/验收/交付 同族；delivered 归并已交付）', () => {
    expect(PROJECT_STATUS_LABELS).toEqual({
      pending: '讨论中',
      active: '开发中',
      in_review: '验收中',
      completed: '已交付',
      delivered: '已交付',
      cancelled: '已取消',
    });
  });

  it('每个状态词都有对应配色（PmoNumberBadge/ProjectCard 同源）', () => {
    for (const key of Object.keys(PROJECT_STATUS_LABELS)) {
      expect(PROJECT_STATUS_COLORS[key], `缺少 ${key} 配色`).toBeTruthy();
    }
  });
});

describe('DELIVERY_POLICY_LABELS', () => {
  it('交付策略 → 中文文案（auto-merge=自动合并 / branch-only=分支交付），界面不出现裸英文策略值', () => {
    expect(DELIVERY_POLICY_LABELS).toEqual({
      'auto-merge': '自动合并',
      'branch-only': '分支交付',
    });
  });
});
