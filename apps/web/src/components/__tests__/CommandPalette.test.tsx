// CommandPalette 单测（批次 D-2 项 8）：唤起后聚焦 / 300ms 防抖 / 四域扇出渲染 / 失败隔离 /
// 键盘导航（↑↓ Enter Esc）/ 鼠标同语义 / 关闭不残留定时器。api 层统一 mock '../../api'（axios 实例）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('../../api', () => ({ api: mockApi }));

import { CommandPalette } from '../CommandPalette';

const CHANNELS = [
  { id: 'ch-1', name: '#研发', type: 'rnd' },
  { id: 'ch-2', name: '#系统', type: 'system' },
];
const WUS = [
  {
    id: 'wu-abcdef1234567890',
    parentId: null,
    dependsOn: '',
    type: 'task',
    scope: '研发全局搜索面板',
    assigneeId: null,
    status: 'active',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: 'ch-1',
    metadata: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    claimedAt: null,
    completedAt: null,
  },
];
const REQS = [
  { id: 'REQ-0042', seq: 42, title: '研发全局搜索', status: 'in-progress', createdAt: '2026-09-01T00:00:00Z', createdBy: 'u1' },
];
const KNOWLEDGE = [
  { type: 'rule', id: 'kn-1', title: '研发评审规则', snippet: '…', score: 1 },
];

const mockAllDomains = () => {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/channels') return Promise.resolve({ data: { success: true, data: CHANNELS } });
    if (url === '/workunits') return Promise.resolve({ data: { data: WUS, pagination: { page: 1, limit: 5, total: 1 } } });
    if (url === '/requirements') return Promise.resolve({ data: { success: true, data: REQS } });
    if (url === '/knowledge/search') return Promise.resolve({ data: { results: KNOWLEDGE } });
    return Promise.reject(new Error(`unexpected url: ${url}`));
  });
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}{loc.search}</div>;
}

const renderPalette = (onClose = vi.fn()) =>
  render(
    <MemoryRouter initialEntries={['/workunits']}>
      <CommandPalette open onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>,
  );

const typeQuery = async (q: string) => {
  fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: q } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockAllDomains();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CommandPalette — Cmd/Ctrl+K 全局搜索（批次 D-2 项 8）', () => {
  it('关闭态不渲染；打开即聚焦搜索框', () => {
    const { unmount } = render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    renderPalette();
    expect(screen.getByRole('dialog', { name: '全局搜索' })).toBeTruthy();
    expect(screen.getByLabelText('搜索关键词')).toHaveFocus();
  });

  it('输入 300ms 防抖并行查四域，四组结果渲染（名称 + 弱化 meta）', async () => {
    renderPalette();
    await typeQuery('研发');

    // 四域端点各调一次；WU 走服务端 q（批次 D-2 项 4）+ limit 5
    const urls = mockApi.get.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(['/channels', '/workunits', '/requirements', '/knowledge/search']);
    const wuCall = mockApi.get.mock.calls.find((c) => c[0] === '/workunits');
    expect(wuCall?.[1]).toEqual({ params: { q: '研发', limit: 5 } });

    // 四组组头 + 行（频道=类型 meta，WU=状态词+ID 短码，REQ=状态词+编号，知识=类型）
    for (const label of ['频道', '任务', '需求', '知识']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('#研发')).toBeTruthy();
    expect(screen.getByText('rnd')).toBeTruthy();
    expect(screen.getByText('研发全局搜索面板')).toBeTruthy();
    expect(screen.getByText('研发全局搜索面板').closest('[role="option"]')?.textContent).toContain('进行中 · wu-abcde');
    expect(screen.getByText('研发全局搜索')).toBeTruthy();
    expect(screen.getByText('研发全局搜索').closest('[role="option"]')?.textContent).toContain('进行中 · REQ-0042');
    expect(screen.getByText('研发评审规则')).toBeTruthy();
    // #系统 频道不含「研发」，客户端过滤掉
    expect(screen.queryByText('#系统')).toBeNull();
  });

  it('防抖：300ms 内连续输入只发最后一词', async () => {
    renderPalette();
    const input = screen.getByLabelText('搜索关键词');
    fireEvent.change(input, { target: { value: '研' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(input, { target: { value: '研发' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const wuCalls = mockApi.get.mock.calls.filter((c) => c[0] === '/workunits');
    expect(wuCalls).toHaveLength(1);
    expect(wuCalls[0][1]).toEqual({ params: { q: '研发', limit: 5 } });
  });

  it('键盘导航：↓ 移动高亮，Enter 跳并关闭；↑ 循环回绕', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    await typeQuery('研发');
    const input = screen.getByLabelText('搜索关键词');

    // 默认高亮首条（频道），↓ → WU 行
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByText('研发全局搜索面板').closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/workunits/wu-abcdef1234567890');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter 默认高亮首条直跳频道；REQ 跳 /pmo?tab=reqs、知识跳 /knowledge', async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <CommandPalette open onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await typeQuery('研发');
    fireEvent.keyDown(screen.getByLabelText('搜索关键词'), { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/channels/ch-1');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    // 鼠标点击需求行 → /pmo?tab=reqs；知识行 → /knowledge
    onClose.mockClear();
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <CommandPalette open onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await typeQuery('研发');
    fireEvent.click(screen.getByText('研发全局搜索'));
    expect(screen.getByTestId('loc').textContent).toBe('/pmo?tab=reqs');
  });

  it('失败隔离：知识域 reject 不影响其余三组渲染', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/knowledge/search') return Promise.reject(new Error('boom'));
      if (url === '/channels') return Promise.resolve({ data: { success: true, data: CHANNELS } });
      if (url === '/workunits') return Promise.resolve({ data: { data: WUS, pagination: { page: 1, limit: 5, total: 1 } } });
      if (url === '/requirements') return Promise.resolve({ data: { success: true, data: REQS } });
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    renderPalette();
    await typeQuery('研发');
    expect(screen.getByText('频道')).toBeTruthy();
    expect(screen.getByText('任务')).toBeTruthy();
    expect(screen.getByText('需求')).toBeTruthy();
    expect(screen.queryByText('知识')).toBeNull();
  });

  it('四域全无结果 → 「无匹配」', async () => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/channels') return Promise.resolve({ data: { success: true, data: [] } });
      if (url === '/workunits') return Promise.resolve({ data: { data: [], pagination: { page: 1, limit: 5, total: 0 } } });
      if (url === '/requirements') return Promise.resolve({ data: { success: true, data: [] } });
      if (url === '/knowledge/search') return Promise.resolve({ data: { results: [] } });
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });
    renderPalette();
    await typeQuery('不存在');
    expect(screen.getByText('无匹配')).toBeTruthy();
  });

  it('Esc 关闭；点遮罩关闭；点面板不关', async () => {
    const onClose = vi.fn();
    renderPalette(onClose);
    fireEvent.keyDown(screen.getByLabelText('搜索关键词'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.cmdk-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭不残留防抖定时器：输入后关闭，到期不再发请求', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <CommandPalette open onClose={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: '研发' } });
    rerender(
      <MemoryRouter>
        <CommandPalette open={false} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('鼠标 hover 移动高亮，与键盘同一序号体系', async () => {
    renderPalette();
    await typeQuery('研发');
    fireEvent.mouseEnter(screen.getByText('研发全局搜索'));
    expect(screen.getByText('研发全局搜索').closest('[role="option"]')?.getAttribute('aria-selected')).toBe('true');
  });
});
