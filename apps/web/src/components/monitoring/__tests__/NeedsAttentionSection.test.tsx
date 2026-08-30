// Contract test: NeedsAttentionSection — #184 监控页「需要处理」区（#62 D4 + #60 IA：行动信号优先）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const { mockSearch, mockList } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock('../../../api/events', () => ({
  eventsApi: { search: mockSearch },
}));

vi.mock('../../../api/workunit', () => ({
  workunitApi: { list: mockList },
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}));

import { NeedsAttentionSection } from '../NeedsAttentionSection';

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** 按 type 路由事件检索 mock；各类型默认空 */
function mockEventsByType(map: Record<string, Array<Record<string, unknown>>>) {
  mockSearch.mockImplementation((params: { type?: string }) =>
    Promise.resolve({
      data: {
        events: (params.type && map[params.type]) || [],
        total: (params.type && map[params.type]?.length) || 0,
        nextCursor: null,
      },
    }),
  );
}

/** 按 status 路由 workunitApi.list mock；默认空列表 */
function mockWuByStatus(map: Record<string, { total?: number; data?: Array<Record<string, unknown>> }>) {
  mockList.mockImplementation((params?: { status?: string }) => {
    const entry = (params?.status && map[params.status]) || { total: 0, data: [] };
    const data = entry.data ?? [];
    const total = entry.total ?? data.length;
    // 对齐真实 API 响应形状（formatPaginatedResponse）：总数在 pagination.total（#309）
    return Promise.resolve({
      data: { data, pagination: { page: 1, limit: 200, total, totalPages: Math.ceil(total / 200) } },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEventsByType({});
  mockWuByStatus({});
});

describe('NeedsAttentionSection — 告警收件箱', () => {
  it('渲染告警级别 + message + 相对时间；非法 JSON 行跳过', async () => {
    mockEventsByType({
      'monitor:alert': [
        { type: 'monitor:alert', level: 'warning', payload: JSON.stringify({ message: '未认领池滞留：最老任务已滞留 5h' }), createdAt: iso(3 * HOUR) },
        { type: 'monitor:alert', level: 'critical', payload: JSON.stringify({ message: '执行 loop 失联：心跳过期' }), createdAt: iso(30 * 60_000) },
        { type: 'monitor:alert', level: 'warning', payload: 'not-json{', createdAt: iso(10 * 60_000) },
      ],
    });
    render(<NeedsAttentionSection />);

    expect(await screen.findByText('未认领池滞留：最老任务已滞留 5h')).toBeDefined();
    expect(screen.getByText('执行 loop 失联：心跳过期')).toBeDefined();
    expect(screen.getByText('警告')).toBeDefined();
    expect(screen.getByText('严重')).toBeDefined();
    expect(screen.getByText('3 小时前')).toBeDefined();
    // 非法 JSON 行不渲染、不报错
    expect(screen.queryByText('not-json')).toBeNull();
  });

  it('告警检索带 type=monitor:alert、level=warning、since（24h 窗口）', async () => {
    render(<NeedsAttentionSection />);
    await screen.findByText('现在没有需要你处理的事');
    const alertCall = mockSearch.mock.calls.find(c => c[0]?.type === 'monitor:alert');
    expect(alertCall).toBeDefined();
    expect(alertCall![0].level).toBe('warning');
    expect(alertCall![0].limit).toBe(200);
    const since = new Date(alertCall![0].since).getTime();
    expect(Math.abs(Date.now() - since - 24 * HOUR)).toBeLessThan(60_000);
  });

  it('有告警但无其他事项时，不出现空态文案', async () => {
    mockEventsByType({
      'monitor:alert': [
        { type: 'monitor:alert', level: 'warning', payload: JSON.stringify({ message: '有告警' }), createdAt: iso(HOUR) },
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('有告警')).toBeDefined();
    expect(screen.queryByText('现在没有需要你处理的事')).toBeNull();
  });
});

describe('NeedsAttentionSection — 告警分组（#398 §7.3）', () => {
  const alert = (level: string, message: string, msAgo: number) => ({
    type: 'monitor:alert', level, payload: JSON.stringify({ message }), createdAt: iso(msAgo),
  });

  it('同签名告警归并为一行：级别 pill + 文案 + ×N + 最近发生时间', async () => {
    mockEventsByType({
      'monitor:alert': [
        alert('warning', '未认领池滞留：最老任务已滞留 5h', 5 * HOUR),
        alert('warning', '未认领池滞留：最老任务已滞留 6h', 2 * HOUR),
        alert('warning', '未认领池滞留：最老任务已滞留 7h', HOUR),
      ],
    });
    render(<NeedsAttentionSection />);
    // 文案取最近一条原文，只出现一次
    expect(await screen.findByText('未认领池滞留：最老任务已滞留 7h')).toBeDefined();
    expect(screen.queryByText('未认领池滞留：最老任务已滞留 5h')).toBeNull();
    expect(screen.getByText('×3')).toBeDefined();
    expect(screen.getByText('1 小时前')).toBeDefined();
  });

  it('22px 主数字 = 待处理告警组数', async () => {
    mockEventsByType({
      'monitor:alert': [
        alert('warning', '滞留 5h', HOUR),
        alert('warning', '滞留 6h', 2 * HOUR),
        alert('critical', '心跳过期', 3 * HOUR),
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('心跳过期')).toBeDefined();
    // 组数 2 作为主数字渲染（告警组数徽标）
    expect(screen.getByTestId('alert-group-count').textContent).toBe('2');
  });

  it('组数 >3 默认折叠为「还有 N 类」，点击展开全部', async () => {
    mockEventsByType({
      'monitor:alert': [
        alert('warning', '甲类故障 1', HOUR),
        alert('warning', '乙类故障 2', 2 * HOUR),
        alert('warning', '丙类故障 3', 3 * HOUR),
        alert('critical', '丁类故障 4', 4 * HOUR),
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('丁类故障 4')).toBeDefined();
    // 排序 = critical 优先 + 最近时间降序 → 可见 3 组为丁/甲/乙，丙（最旧）收起
    expect(screen.queryByText('丙类故障 3')).toBeNull();
    const toggle = screen.getByText(/还有 1 类/);
    fireEvent.click(toggle);
    expect(await screen.findByText('丙类故障 3')).toBeDefined();
  });

  it('组数 ≤3 不出现折叠开关', async () => {
    mockEventsByType({
      'monitor:alert': [
        alert('warning', '甲类故障', HOUR),
        alert('warning', '乙类故障', 2 * HOUR),
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('甲类故障')).toBeDefined();
    expect(screen.queryByText(/还有 \d+ 类/)).toBeNull();
  });
});

describe('NeedsAttentionSection — 卡住计数', () => {
  it('三类计数非零才显示，带下钻链接', async () => {
    mockWuByStatus({
      blocked: { total: 4 },
      unassigned: {
        data: [
          { id: 'wu-old', createdAt: iso(3 * HOUR) },       // >2h → 滞留
          { id: 'wu-new', createdAt: iso(30 * 60_000) },    // <2h → 不算
        ],
      },
      active: {
        data: [
          { id: 'wu-stale', timeoutAt: iso(10 * 60_000) },  // 已过期 → 停滞
          { id: 'wu-live', timeoutAt: new Date(Date.now() + 5 * 60_000).toISOString() }, // 未过期
          { id: 'wu-nolease', timeoutAt: null },            // 无租约 → 不算
        ],
      },
    });
    render(<NeedsAttentionSection />);

    const blocked = await screen.findByText(/阻塞 4 个/);
    expect(blocked.closest('a')?.getAttribute('href')).toBe('/workunits?status=blocked');

    const stale = screen.getByText(/待认领滞留 1 个/);
    expect(stale.closest('a')?.getAttribute('href')).toBe('/workunits?status=unassigned');

    const stalled = screen.getByText(/执行中停滞 1 个/);
    expect(stalled.closest('a')?.getAttribute('href')).toBe('/workunits?status=active');
  });

  it('计数为 0 的类别不显示', async () => {
    mockWuByStatus({ blocked: { total: 2 } });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/阻塞 2 个/)).toBeDefined();
    expect(screen.queryByText(/待认领滞留/)).toBeNull();
    expect(screen.queryByText(/执行中停滞/)).toBeNull();
  });
});

describe('NeedsAttentionSection — 近 24 小时失败趋势', () => {
  /** 构造执行步事件：recentFail/recentOk 个近 24h 失败/成功步，prevFail/prevOk 个前 24h */
  function mockStepEvents(recentFail: number, recentOk: number, prevFail: number, prevOk: number, recentWuFailed = 0, prevWuFailed = 0) {
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < recentFail; i++) steps.push({ type: 'workunit:execution_step', payload: JSON.stringify({ step: 1, status: 'failed' }), createdAt: iso(2 * HOUR) });
    for (let i = 0; i < recentOk; i++) steps.push({ type: 'workunit:execution_step', payload: JSON.stringify({ step: 1, status: 'success' }), createdAt: iso(2 * HOUR) });
    for (let i = 0; i < prevFail; i++) steps.push({ type: 'workunit:execution_step', payload: JSON.stringify({ step: 1, status: 'failed' }), createdAt: iso(30 * HOUR) });
    for (let i = 0; i < prevOk; i++) steps.push({ type: 'workunit:execution_step', payload: JSON.stringify({ step: 1, status: 'success' }), createdAt: iso(30 * HOUR) });
    const wuFailed: Array<Record<string, unknown>> = [];
    for (let i = 0; i < recentWuFailed; i++) wuFailed.push({ type: 'workunit:failed', payload: '{}', createdAt: iso(2 * HOUR) });
    for (let i = 0; i < prevWuFailed; i++) wuFailed.push({ type: 'workunit:failed', payload: '{}', createdAt: iso(30 * HOUR) });
    mockEventsByType({ 'workunit:execution_step': steps, 'workunit:failed': wuFailed });
  }

  it('失败率走高 → ↑（变糟）', async () => {
    // 近 24h：1 失败步 + 1 workunit:failed + 3 成功步 → N=2，率 2/5=40%
    // 前 24h：1 失败步 + 9 成功步 → 率 10%
    mockStepEvents(1, 3, 1, 9, 1, 0);
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/近 24 小时失败 2 次/)).toBeDefined();
    expect(screen.getByText(/失败率 40%/)).toBeDefined();
    expect(screen.getByText('↑')).toBeDefined();
    expect(screen.getByText(/比前一天/)).toBeDefined();
  });

  it('失败率走低 → ↓（好转）', async () => {
    // 近 24h：1/10=10%；前 24h：2/4=50%
    mockStepEvents(1, 9, 2, 2);
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 10%/)).toBeDefined();
    expect(screen.getByText('↓')).toBeDefined();
  });

  it('失败率持平 → →', async () => {
    // 两窗口各 1/2=50%
    mockStepEvents(1, 1, 1, 1);
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 50%/)).toBeDefined();
    expect(screen.getByText('→')).toBeDefined();
  });

  it('前 24h 无样本 → 箭头显示 –', async () => {
    mockStepEvents(1, 1, 0, 0);
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 50%/)).toBeDefined();
    expect(screen.getByText('–')).toBeDefined();
  });

  it('失败统计口径：workunit:failed + 失败步计入 N', async () => {
    // 3 失败步 + 2 workunit:failed + 5 成功步 → N=5，率 50%
    mockStepEvents(3, 5, 0, 0, 2, 0);
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/近 24 小时失败 5 次/)).toBeDefined();
    expect(screen.getByText(/失败率 50%/)).toBeDefined();
  });
});

describe('NeedsAttentionSection — 空态与容错', () => {
  it('全部为 0 且无告警 → 「现在没有需要你处理的事」', async () => {
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('现在没有需要你处理的事')).toBeDefined();
    expect(screen.queryByText(/阻塞/)).toBeNull();
    expect(screen.queryByText(/近 24 小时失败/)).toBeNull();
  });

  it('事件 API 失败 → 显示加载失败提示，不抛错', async () => {
    mockSearch.mockRejectedValue(new Error('boom'));
    render(<NeedsAttentionSection />);
    const hints = await screen.findAllByText(/加载失败/);
    expect(hints.length).toBeGreaterThan(0);
    // 任务计数部分（workunitApi 正常）不受事件 API 失败影响
    expect(screen.queryByText('现在没有需要你处理的事')).toBeNull();
  });

  it('无告警但有卡住任务时显示「暂无告警」', async () => {
    mockWuByStatus({ blocked: { total: 1 } });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/阻塞 1 个/)).toBeDefined();
    expect(screen.getByText('暂无告警')).toBeDefined();
  });
});
