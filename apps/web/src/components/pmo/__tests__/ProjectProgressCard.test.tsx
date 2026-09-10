// ProjectProgressCard tests — #399 §8.2 进展卡新构成；#474 减噪修订：
// 进展卡折叠为次要块（头部恒显「项目进展 + %」，详情默认收起，点「展开」看进度条/Token/口径副标题）；
// 「已完成 n/m」删除（与 DeliveryPanel 台账「任务: n/m 完成」重复，同一事实只表达一次）；去 emoji（💰/⚠️）。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectProgressCard } from '../ProjectProgressCard';
import type { DeliveryStatus } from '../../../api';

const baseDelivery: DeliveryStatus = {
  projectId: 'p1',
  pmoNumber: 'PMO-11',
  branch: 'PMO-11',
  policy: 'auto-merge',
  gitRepo: '/x',
  wu: { total: 12, finished: 8, inFlight: 4, byStatus: { unassigned: 1, active: 2, inReview: 1, blocked: 0 } },
  evidence: { l1Missing: [], l2Missing: [], l3Missing: [], selfReviewCount: 3 },
  deliverable: false,
  missing: [],
  tokens: 1234567,
  archived: false,
  gaps: [],
  deliveredAt: null,
  deliveredBy: null,
  deliverCommit: null,
};

const renderCard = (over: Partial<Parameters<typeof ProjectProgressCard>[0]> = {}) =>
  render(<ProjectProgressCard progress={67} delivery={baseDelivery} projectStatus="active" {...over} />);

describe('ProjectProgressCard（#474 折叠次要块）', () => {
  it('头部恒显 %（--fs-stat mono）；详情默认折叠，展开见进度条/Token meta/口径副标题', () => {
    renderCard();

    const pct = screen.getByText('67%');
    expect(pct.style.fontSize).toBe('var(--fs-stat)');
    expect(pct.className).toContain('font-mono');

    // 默认折叠：Token/副标题不可见
    expect(screen.queryByText(/tokens（全周期累计）/)).toBeNull();
    expect(screen.queryByText('完成数 = 已交付的任务，验收中的不计入')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByText(/1\.2M tokens（全周期累计）/)).toBeTruthy();
    const subtitle = screen.getByText('完成数 = 已交付的任务，验收中的不计入');
    expect(subtitle.style.fontSize).toBe('var(--fs-xs)');

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText(/tokens（全周期累计）/)).toBeNull();
  });

  it('「已完成 n/m」已删（与交付台账「任务: n/m 完成」重复，同一事实只表达一次）', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.queryByText(/已完成 \d+\/\d+/)).toBeNull();
  });

  it('六卡已删：状态计数不再以卡片形式出现（泳道头为唯一计数表达）', () => {
    renderCard();

    expect(screen.queryByText('✅ 完成')).toBeNull();
    expect(screen.queryByText('👀 待验收')).toBeNull();
    expect(screen.queryByText('🚫 阻塞')).toBeNull();
    expect(screen.queryByText('💰 Token')).toBeNull();
  });

  it('delivery 为 null：只剩 %（展开后无 Token meta 与副标题）', () => {
    renderCard({ delivery: null });

    expect(screen.getByText('67%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.queryByText(/tokens（全周期累计）/)).toBeNull();
    expect(screen.queryByText('完成数 = 已交付的任务，验收中的不计入')).toBeNull();
  });

  it('证据警告条保留原位：completed 且证据有缺口 → 琥珀条，L1/L2/L3 写白话（缺的层为 0 不出现）', () => {
    renderCard({
      projectStatus: 'completed',
      delivery: {
        ...baseDelivery,
        evidence: { l1Missing: ['wu-1', 'wu-2'], l2Missing: [], l3Missing: ['wu-2'], selfReviewCount: 0 },
      },
    });

    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'DIV' &&
          el.textContent ===
            '项目已标记完成，但交付证据未齐（2 个任务缺自动验证 · 1 个缺人工确认）——在上方交付卡补齐后才算真正交付',
      ),
    ).toBeTruthy();
  });

  it('completed 但证据已齐 → 不出警告条', () => {
    renderCard({ projectStatus: 'completed', delivery: { ...baseDelivery, deliverable: true } });
    expect(screen.queryByText(/项目已标记完成/)).toBeNull();
  });

  it('in_review 且证据未齐 → 自动翻转说明条保留', () => {
    renderCard({ projectStatus: 'in_review' });
    expect(screen.getByText('交付证据补齐后，项目将自动标记完成')).toBeTruthy();
  });

  it('#376 归档口径：archived → 展开后归档提示取代 Token meta 与口径副标题（100% 快照照显）', () => {
    renderCard({
      progress: 100,
      projectStatus: 'completed',
      delivery: {
        ...baseDelivery,
        archived: true,
        wu: { total: 0, finished: 0, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
        tokens: 0,
      },
    });

    expect(screen.getByText('100%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByText('任务明细已归档', { selector: 'span' })).toBeTruthy();
    expect(
      screen.getByText('任务明细已归档：百分比为完成时快照，完成数与 Token 为实时重算口径，历史任务数据已清理'),
    ).toBeTruthy();
    expect(screen.queryByText(/已完成 \d+\/\d+/)).toBeNull();
    expect(screen.queryByText(/tokens（全周期累计）/)).toBeNull();
    expect(screen.queryByText('完成数 = 已交付的任务，验收中的不计入')).toBeNull();
  });

  it('#376 归档口径：非 archived 零任务项目不显示归档提示', () => {
    renderCard({
      delivery: {
        ...baseDelivery,
        wu: { total: 0, finished: 0, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
        tokens: 0,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.queryByText(/任务明细已归档/)).toBeNull();
  });
});
