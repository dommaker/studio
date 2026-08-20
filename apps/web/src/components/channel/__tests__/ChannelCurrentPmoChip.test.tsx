/**
 * #272（决策 #251 Q6）：顶栏「当前 PMO」chip。
 * 派生数据来自 GET /channels/:id/current-pmo；点击跳项目页；
 * 多仓 PMO chip 只显名称，hover tooltip 列 gitRepos；无派生结果不渲染。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelCurrentPmoChip } from '../ChannelCurrentPmoChip';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../api/channel', () => ({
  channelApi: {
    getCurrentPmo: vi.fn(),
  },
}));

import { channelApi } from '../../../api/channel';

const renderChip = (channelId = 'ch-1') =>
  render(
    <MemoryRouter>
      <ChannelCurrentPmoChip channelId={channelId} />
    </MemoryRouter>,
  );

describe('ChannelCurrentPmoChip（#272 当前 PMO chip）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('派生结果为 null → 不渲染', async () => {
    vi.mocked(channelApi.getCurrentPmo).mockResolvedValue({
      data: { success: true, data: null },
    } as never);
    const { container } = renderChip();
    await waitFor(() => expect(channelApi.getCurrentPmo).toHaveBeenCalledWith('ch-1'));
    expect(container.querySelector('.mc-pmo-chip')).toBeNull();
  });

  it('渲染 PMO 名称，点击跳项目页', async () => {
    vi.mocked(channelApi.getCurrentPmo).mockResolvedValue({
      data: { success: true, data: { id: 'proj-1', pmoNumber: 'PMO-1', title: '商城重构', gitRepos: ['/repo/a'] } },
    } as never);
    renderChip();

    const chip = await screen.findByText(/商城重构/);
    fireEvent.click(chip);
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-1');
  });

  it('多仓 PMO：chip 只显名称，tooltip 列全部 gitRepos', async () => {
    vi.mocked(channelApi.getCurrentPmo).mockResolvedValue({
      data: {
        success: true,
        data: { id: 'proj-2', pmoNumber: 'PMO-2', title: '多仓项目', gitRepos: ['/repo/a', '/repo/b'] },
      },
    } as never);
    renderChip();

    const chip = (await screen.findByText(/多仓项目/)).closest('button')!;
    expect(chip.textContent).not.toContain('/repo/a');
    expect(chip.title).toContain('/repo/a');
    expect(chip.title).toContain('/repo/b');
  });

  it('接口失败 → 不渲染不抛错', async () => {
    vi.mocked(channelApi.getCurrentPmo).mockRejectedValue(new Error('network'));
    const { container } = renderChip();
    await waitFor(() => expect(channelApi.getCurrentPmo).toHaveBeenCalled());
    expect(container.querySelector('.mc-pmo-chip')).toBeNull();
  });
});
