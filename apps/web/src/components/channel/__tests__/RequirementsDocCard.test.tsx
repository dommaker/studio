// RequirementsDocCard — #278 只读化回归 + 决策 7（2026-08 SSE 负载加深）：5s 轮询死代码删除
// 死代码依据：#278 产卡链已删、卡只读化；全后端无 meta.status='executing' 写入方 → 轮询分支对新卡从不触发
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGetChain } = vi.hoisted(() => ({ mockGetChain: vi.fn() }));

vi.mock('../../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));

import { RequirementsDocCard } from '../RequirementsDocCard';
import type { ChannelMessage } from '../../../api/channel';
import type { CardMeta } from '../../../utils/messageMeta';

const MESSAGE: ChannelMessage = {
  id: 'm-1',
  channelId: 'ch-1',
  authorType: 'agent',
  agentName: 'analyst',
  content: '需求文档正文',
  workUnitId: null,
  replyToId: null,
  meta: '{}',
  createdAt: '2026-08-01T00:00:00Z',
};

const renderCard = (meta: CardMeta) =>
  render(
    <MemoryRouter>
      <RequirementsDocCard message={MESSAGE} meta={meta} onAction={vi.fn()} />
    </MemoryRouter>,
  );

describe('RequirementsDocCard（决策 7：删 5s 轮询死代码）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('任何状态下都不注册 setInterval（含 executing 遗产卡）', () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    renderCard({ cardType: 'requirements_doc', status: 'executing', requirementId: 'REQ-0001' });
    renderCard({ cardType: 'requirements_doc', status: 'ready', requirementId: 'REQ-0002' });
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('executing 遗产卡不再拉取 REQ 链路进度（无 fetchReqProgress 残留）', () => {
    vi.useFakeTimers();
    renderCard({ cardType: 'requirements_doc', status: 'executing', requirementId: 'REQ-0001' });
    vi.advanceTimersByTime(30_000);
    expect(mockGetChain).not.toHaveBeenCalled();
  });

  it('executing 遗产卡渲染不炸：状态 chip + 正文，无进度条区块', () => {
    renderCard({ cardType: 'requirements_doc', status: 'executing', requirementId: 'REQ-0001' });
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText('需求文档正文')).toBeTruthy();
    expect(screen.queryByText(/执行进度/)).toBeNull();
    expect(screen.queryByText(/执行已启动/)).toBeNull();
  });

  it('ready 卡保留只读化淡注「该确认入口已下线」（#278 回归）', () => {
    renderCard({ cardType: 'requirements_doc', status: 'ready' });
    expect(screen.getByText('该确认入口已下线')).toBeTruthy();
  });

  it('done / error 历史卡静态渲染（回归）', () => {
    renderCard({ cardType: 'requirements_doc', status: 'done' });
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.getByText('需求已完成')).toBeTruthy();
    renderCard({ cardType: 'requirements_doc', status: 'error', error: 'LLM 超时' });
    expect(screen.getByText('错误: LLM 超时')).toBeTruthy();
  });
});
