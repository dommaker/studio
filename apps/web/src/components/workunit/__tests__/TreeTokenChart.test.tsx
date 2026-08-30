// #396：Token 开销图表化 —— 左栏事实行入口 + 双 stat/预算占比/per-node 堆叠条面板（零图表库）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const { mockGetTreeTokens } = vi.hoisted(() => ({ mockGetTreeTokens: vi.fn() }));

vi.mock('../../../api/workunit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/workunit')>();
  return { ...actual, workunitApi: { ...actual.workunitApi, getTreeTokens: mockGetTreeTokens } };
});

import { TreeTokenEntry } from '../TreeTokenChart';

const report = {
  rootId: 'wu-root',
  rootTotal: 12000,
  budgetRemaining: 8000,
  nodes: [
    { workUnitId: 'wu-bbbb2222', profileName: null, status: 'active', injectedTokens: 1000, executionTokens: 1500, totalTokens: 2500 },
    { workUnitId: 'wu-aaaa1111', profileName: 'coder-01', status: 'done', injectedTokens: 5000, executionTokens: 7000, totalTokens: 12000 },
  ],
};

describe('TreeTokenChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTreeTokens.mockResolvedValue({ data: report });
  });

  it('事实行入口：mono 总耗 + 迷你预算占比条；点击开图表面板', async () => {
    const { container } = render(<TreeTokenEntry workUnitId="wu-root" />);
    const btn = await screen.findByRole('button', { name: /12\.0k/ });
    expect(container.querySelector('.wu-token-minibar')).not.toBeNull();
    fireEvent.click(btn);
    expect(await screen.findByText('协作树 Token 开销')).toBeDefined();
  });

  it('面板：双 stat（树总耗/预算剩余）+ 预算占比 caption', async () => {
    render(<TreeTokenEntry workUnitId="wu-root" />);
    fireEvent.click(await screen.findByRole('button', { name: /12\.0k/ }));
    expect(await screen.findByText('树总耗')).toBeDefined();
    expect(screen.getByText('预算剩余')).toBeDefined();
    expect(screen.getByText('8.0k')).toBeDefined();
    expect(screen.getByText(/已用 12\.0k \/ 预算 20\.0k（60%）/)).toBeDefined();
  });

  it('per-node 堆叠条：按总耗降序、注入/执行两段分色、图例；profileName 缺省显示 -', async () => {
    const { container } = render(<TreeTokenEntry workUnitId="wu-root" />);
    fireEvent.click(await screen.findByRole('button', { name: /12\.0k/ }));
    await screen.findByText('树总耗');
    const ids = [...container.querySelectorAll('.wu-token-row-id')].map(el => el.textContent);
    expect(ids).toEqual(['wu-aaaa1', 'wu-bbbb2']);
    expect(container.querySelectorAll('.wu-token-rows .wu-token-seg-inj').length).toBe(2);
    expect(container.querySelectorAll('.wu-token-rows .wu-token-seg-exec').length).toBe(2);
    expect(screen.getByText('注入')).toBeDefined();
    expect(screen.getByText('执行')).toBeDefined();
    expect(screen.getByText('coder-01')).toBeDefined();
    // 首行数值（降序第一 = 12.0k）
    const values = [...container.querySelectorAll('.wu-token-row-v')].map(el => el.textContent);
    expect(values).toEqual(['12.0k', '2.5k']);
  });

  it('拉取在途：事实行显示 -，面板显示加载中', async () => {
    mockGetTreeTokens.mockReturnValue(new Promise(() => {}));
    render(<TreeTokenEntry workUnitId="wu-root" />);
    const btn = await screen.findByRole('button', { name: /-/ });
    fireEvent.click(btn);
    expect(await screen.findByText('加载中...')).toBeDefined();
  });

  it('接口失败：事实行降级 -，不炸页面', async () => {
    mockGetTreeTokens.mockRejectedValue(new Error('500'));
    render(<TreeTokenEntry workUnitId="wu-root" />);
    expect(await screen.findByRole('button', { name: /-/ })).toBeDefined();
  });
});
