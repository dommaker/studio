// #275（#251 断点3）：footer REQ›/PMO› 行为契约——随 F1 修复（#264 meta 双型解析）复活后的防回归。
// 关键场景：REST/SSE 出口 meta 为 object（不是 string），footer 链接必须照常渲染；
// REQ › 维持抽屉回调模式（onOpenRequirement），PMO › 页面级跳转运 react-router。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ChannelMessage } from '../../../api/channel';
import { ChannelMessageItem } from '../ChannelMessageItem';

const msgWithMeta = (meta: Record<string, unknown>): ChannelMessage => ({
  id: 'm1',
  channelId: 'ch1',
  authorType: 'agent',
  agentName: 'dev-agent',
  content: '里程碑：REQ 已立项',
  meta, // object 形态——F1 现场的真实下发型（string 形态由 messageMeta.test 覆盖）
  createdAt: '2026-08-19T00:00:00.000Z',
});

const renderItem = (message: ChannelMessage, onOpenRequirement?: (reqId: string) => void) =>
  render(
    <MemoryRouter initialEntries={['/channels/ch1']}>
      <Routes>
        <Route
          path="/channels/:id"
          element={<ChannelMessageItem message={message} onAction={vi.fn()} onOpenRequirement={onOpenRequirement} />}
        />
        <Route path="/pmo/project/:id" element={<div>项目页</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('ChannelMessageItem — footer REQ›/PMO›（#275 断点3）', () => {
  it('object meta 带 requirementId + pmoId → REQ › 与 PMO › 均渲染（不再被解析吞掉）', () => {
    renderItem(msgWithMeta({ requirementId: 'REQ-0042', pmoId: 'PMO-7' }), vi.fn());
    expect(screen.getByRole('button', { name: 'REQ-0042 ›' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开项目详情' })).toBeTruthy();
  });

  it('REQ › 维持回调模式：点击调 onOpenRequirement（开抽屉），不走路由', () => {
    const onOpenRequirement = vi.fn();
    renderItem(msgWithMeta({ requirementId: 'REQ-0042' }), onOpenRequirement);
    fireEvent.click(screen.getByRole('button', { name: 'REQ-0042 ›' }));
    expect(onOpenRequirement).toHaveBeenCalledWith('REQ-0042');
    expect(screen.queryByText('项目页')).toBeNull(); // 未发生页面级跳转
  });

  it('meta 无 reqId/pmoId 且无 workUnitId → footer 不渲染', () => {
    const { container } = renderItem(msgWithMeta({}));
    expect(container.querySelector('.mc-card-foot')).toBeNull();
  });
});
