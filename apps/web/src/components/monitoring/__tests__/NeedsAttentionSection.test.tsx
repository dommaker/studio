// Contract test: NeedsAttentionSection — #184 监控页「需要处理」区（#62 D4 + #60 IA：行动信号优先）
// #456：stuck/failure 计数改读 /monitoring/overview 扩段（服务端单源），
// 告警行明细仍前端翻页（#398 签名分组不动）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const { mockSearch, mockGetOverview } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockGetOverview: vi.fn(),
}));

vi.mock('../../../api/events', () => ({
  eventsApi: { search: mockSearch },
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getOverview: mockGetOverview },
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

interface StuckMock { blocked: number; staleUnassigned: number; stalledActive: number }
interface FailureMock { n: number; rate: number | null; trend: 'up' | 'down' | 'flat' | null }

/** overview 扩段 mock；缺省全零（空态） */
function mockOverview(stuck?: Partial<StuckMock>, failure24h?: Partial<FailureMock>) {
  mockGetOverview.mockResolvedValue({
    data: {
      stuck: { blocked: 0, staleUnassigned: 0, stalledActive: 0, ...stuck },
      failure24h: { n: 0, rate: null, trend: null, ...failure24h },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEventsByType({});
  mockOverview();
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

describe('NeedsAttentionSection — 卡住计数（#456 服务端单源）', () => {
  it('三类计数非零才显示，带下钻链接', async () => {
    mockOverview({ blocked: 4, staleUnassigned: 1, stalledActive: 1 });
    render(<NeedsAttentionSection />);

    const blocked = await screen.findByText(/阻塞 4 个/);
    expect(blocked.closest('a')?.getAttribute('href')).toBe('/workunits?status=blocked');

    const stale = screen.getByText(/待领取滞留 1 个/);
    expect(stale.closest('a')?.getAttribute('href')).toBe('/workunits?status=unassigned');

    const stalled = screen.getByText(/执行中停滞 1 个/);
    expect(stalled.closest('a')?.getAttribute('href')).toBe('/workunits?status=active');
  });

  it('计数为 0 的类别不显示', async () => {
    mockOverview({ blocked: 2 });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/阻塞 2 个/)).toBeDefined();
    expect(screen.queryByText(/待领取滞留/)).toBeNull();
    expect(screen.queryByText(/执行中停滞/)).toBeNull();
  });
});

describe('NeedsAttentionSection — 近 24 小时失败趋势（#456 服务端单源）', () => {
  it('失败率走高 → ↑（变糟）', async () => {
    mockOverview({}, { n: 2, rate: 0.4, trend: 'up' });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/近 24 小时失败 2 次/)).toBeDefined();
    expect(screen.getByText(/失败率 40%/)).toBeDefined();
    expect(screen.getByText('↑')).toBeDefined();
    expect(screen.getByText(/比前一天/)).toBeDefined();
  });

  it('失败率走低 → ↓（好转）', async () => {
    mockOverview({}, { n: 1, rate: 0.1, trend: 'down' });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 10%/)).toBeDefined();
    expect(screen.getByText('↓')).toBeDefined();
  });

  it('失败率持平 → →', async () => {
    mockOverview({}, { n: 1, rate: 0.5, trend: 'flat' });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 50%/)).toBeDefined();
    expect(screen.getByText('→')).toBeDefined();
  });

  it('前 24h 无样本（trend=null） → 箭头显示 –', async () => {
    mockOverview({}, { n: 1, rate: 0.5, trend: null });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/失败率 50%/)).toBeDefined();
    expect(screen.getByText('–')).toBeDefined();
  });

  it('近 24h 无执行（rate=null） → 「近 24 小时无执行」', async () => {
    mockOverview({}, { n: 0, rate: null, trend: null });
    mockEventsByType({
      'monitor:alert': [
        { type: 'monitor:alert', level: 'warning', payload: JSON.stringify({ message: '有告警' }), createdAt: iso(HOUR) },
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('近 24 小时无执行')).toBeDefined();
  });
});

describe('NeedsAttentionSection — 空态与容错', () => {
  it('全部为 0 且无告警 → 「现在没有需要你处理的事」', async () => {
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('现在没有需要你处理的事')).toBeDefined();
    expect(screen.queryByText(/阻塞/)).toBeNull();
    expect(screen.queryByText(/近 24 小时失败/)).toBeNull();
  });

  it('事件 API 失败 → 告警区显示加载失败；overview 区不受影响', async () => {
    mockSearch.mockRejectedValue(new Error('boom'));
    mockOverview({ blocked: 1 });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('告警加载失败')).toBeDefined();
    // 任务计数部分（overview 正常）不受事件 API 失败影响
    expect(await screen.findByText(/阻塞 1 个/)).toBeDefined();
    expect(screen.queryByText('现在没有需要你处理的事')).toBeNull();
  });

  it('overview 失败 → 卡住计数与失败趋势各自显示加载失败；告警区不受影响', async () => {
    mockGetOverview.mockRejectedValue(new Error('boom'));
    mockEventsByType({
      'monitor:alert': [
        { type: 'monitor:alert', level: 'warning', payload: JSON.stringify({ message: '有告警' }), createdAt: iso(HOUR) },
      ],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('任务状态加载失败')).toBeDefined();
    expect(screen.getByText('失败统计加载失败')).toBeDefined();
    expect(await screen.findByText('有告警')).toBeDefined();
    expect(screen.queryByText('现在没有需要你处理的事')).toBeNull();
  });

  it('无告警但有卡住任务时显示「暂无告警」', async () => {
    mockOverview({ blocked: 1 });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/阻塞 1 个/)).toBeDefined();
    expect(screen.getByText('暂无告警')).toBeDefined();
  });
});

describe('NeedsAttentionSection — 取数口径（#456）', () => {
  it('stuck/failure 来自同一次 overview 调用（挂载 1 次），不再按状态分别拉 WU 池', async () => {
    mockOverview({ blocked: 1 }, { n: 1, rate: 1, trend: 'up' });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText(/阻塞 1 个/)).toBeDefined();
    expect(await screen.findByText(/近 24 小时失败 1 次/)).toBeDefined();
    expect(mockGetOverview).toHaveBeenCalledTimes(1);
    // 失败趋势不再走事件检索（只有告警检索一类调用）
    expect(mockSearch.mock.calls.every(c => c[0]?.type === 'monitor:alert')).toBe(true);
  });
});

describe('NeedsAttentionSection — 告警下钻（E4）', () => {
  const alert = (level: string, message: string, msAgo: number) => ({
    type: 'monitor:alert', level, payload: JSON.stringify({ message }), createdAt: iso(msAgo),
  });

  it('注入 onAlertClick 时告警行渲染为按钮，点击回传该组（level/message/count/latestAt）', async () => {
    mockEventsByType({
      'monitor:alert': [
        alert('warning', '未认领池滞留：最老任务已滞留 5h', 5 * HOUR),
        alert('warning', '未认领池滞留：最老任务已滞留 7h', HOUR),
        alert('critical', '执行 loop 失联：心跳过期', 2 * HOUR),
      ],
    });
    const onAlertClick = vi.fn();
    render(<NeedsAttentionSection onAlertClick={onAlertClick} />);

    const btn = await screen.findByRole('button', { name: /未认领池滞留：最老任务已滞留 7h/ });
    fireEvent.click(btn);
    expect(onAlertClick).toHaveBeenCalledTimes(1);
    expect(onAlertClick).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warning',
      message: '未认领池滞留：最老任务已滞留 7h',
      count: 2,
    }));
  });

  it('未注入 onAlertClick 时告警行保持纯展示（无按钮语义）', async () => {
    mockEventsByType({
      'monitor:alert': [alert('warning', '滞留 5h', HOUR)],
    });
    render(<NeedsAttentionSection />);
    expect(await screen.findByText('滞留 5h')).toBeDefined();
    expect(screen.queryByRole('button', { name: /滞留 5h/ })).toBeNull();
  });
});
