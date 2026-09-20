// AuditLogsPage — E7 审计日志页改造（docs/plans/2026-09-page-redesign.md）
// 时间范围筛选传后端 / 筛选变化重置 page / userId 300ms 防抖（批次 B-5）/
// 导出带 status（与列表口径一致）/ 视觉收敛（max-w-5xl + StatCard 配方 + mc-block-label 分区）/ 分页文案「上一页/下一页」
// 批次 F-4：错误条补重试 / 导出点击反馈（toast）/ 空态双语境（真空 vs 筛选无结果）
// #591：来源（source）/主体（actorType）筛选 + 用户列 Agent 标识 + 提案终态 status neutral fallback + 导出带新参数
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockList, mockGetStats, mockListActions, mockListResources } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGetStats: vi.fn(),
  mockListActions: vi.fn(),
  mockListResources: vi.fn(),
}));

vi.mock('../../api/auditLogs', async (importActual) => {
  const actual = await importActual<typeof import('../../api/auditLogs')>();
  return {
    ...actual,
    auditLogApi: {
      ...actual.auditLogApi,
      list: mockList,
      getStats: mockGetStats,
      listActions: mockListActions,
      listResources: mockListResources,
    },
  };
});

import { AuditLogsPage } from '../AuditLogsPage';
import { toast } from '../../utils/toast';

const LOGS = [
  {
    id: 'log-1',
    userId: 'user-a',
    action: 'create',
    resource: 'workunit',
    status: 'success',
    createdAt: '2026-09-08T10:00:00Z',
  },
];

const STATS = {
  totalLogs: 100,
  successCount: 80,
  failureCount: 20,
  topActions: [],
  topResources: [],
  topUsers: [],
  dailyStats: [],
};

describe('AuditLogsPage（E7 审计日志页改造）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({
      data: { data: LOGS, pagination: { page: 1, limit: 50, total: 100, totalPages: 2 } },
    });
    mockGetStats.mockResolvedValue({ data: STATS });
    mockListActions.mockResolvedValue({ data: { data: ['create', 'update'] } });
    mockListResources.mockResolvedValue({ data: { data: ['workunit'] } });
  });

  afterEach(() => {
    // 批次 F-4：导出反馈走 toast（挂 document.body），用例间清掉防串扰
    toast.dismiss();
  });

  it('页头：标题去 emoji，「导出」为页头右侧主行动点', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(screen.getByRole('heading', { name: '审计日志' })).toBeTruthy();
    expect(screen.queryByText(/📋/)).toBeNull();
    expect(screen.getByRole('button', { name: '导出' })).toBeTruthy();
  });

  it('视觉收敛：内容区 max-w-5xl + 统计/筛选/表格三区 mc-block-label', async () => {
    const { container } = render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(container.querySelector('.max-w-5xl')).not.toBeNull();
    const labels = [...container.querySelectorAll('.mc-block-label')].map((el) => el.textContent);
    expect(labels).toContain('概览');
    expect(labels).toContain('筛选');
    expect(labels).toContain('日志');
  });

  it('统计卡数字走 --fs-stat + font-mono', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    const total = screen.getByText('100');
    expect(total.style.fontSize).toBe('var(--fs-stat)');
    expect(total.className).toContain('font-mono');
  });

  it('分页文案为「上一页/下一页」', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(screen.getByRole('button', { name: '上一页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
    expect(screen.queryByText('上一步')).toBeNull();
    expect(screen.queryByText('下一步')).toBeNull();
  });

  it('筛选变化重置 page（翻页后改状态筛选回第 1 页）', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );

    fireEvent.click(screen.getByLabelText('状态筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '失败' }));

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'failure', page: 1 }),
      ),
    );
  });

  it('userId 输入 300ms 防抖后才带参拉取', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');
    const callsAfterLoad = mockList.mock.calls.length;

    fireEvent.change(screen.getByPlaceholderText('用户 ID'), { target: { value: 'user-b' } });
    // 防抖窗口内不立即打 API
    expect(mockList.mock.calls.length).toBe(callsAfterLoad);

    await waitFor(
      () =>
        expect(mockList).toHaveBeenLastCalledWith(
          expect.objectContaining({ userId: 'user-b', page: 1 }),
        ),
      { timeout: 1500 },
    );
  });

  it('时间范围筛选：开始/结束日期转为 ISO startTime/endTime 传后端', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    // #549：useAsyncData 切参当帧清数据重置加载态（正本语义）——下一个筛选控件等重拉落定再取
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } });
    fireEvent.change(await screen.findByLabelText('结束日期'), { target: { value: '2026-09-09' } });

    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({
          startTime: new Date('2026-09-01T00:00:00').toISOString(),
          endTime: new Date('2026-09-09T23:59:59.999').toISOString(),
          page: 1,
        }),
      ),
    );
  });

  it('导出带 status 与时间范围参数（与列表口径一致）', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({} as Window));
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByLabelText('状态筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '失败' }));
    // #549：同上——等筛选触发的重拉落定再取日期控件
    fireEvent.change(await screen.findByLabelText('开始日期'), { target: { value: '2026-09-01' } });
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failure' })),
    );

    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = openSpy.mock.calls[0][0] as string;
    expect(url).toContain('/audit-logs/export');
    expect(url).toContain('status=failure');
    expect(url).toContain('startTime=');
    openSpy.mockRestore();
  });

  it('行点击行内展开详情（非弹窗），再点击收起', async () => {
    render(<AuditLogsPage />);
    const cell = await screen.findByText('user-a');
    const row = cell.closest('tr')!;
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ID')).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('ID')).toBeTruthy();
    expect(screen.getByText('log-1')).toBeTruthy();
    // 无遮罩弹窗
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('ID')).toBeNull();
  });

  it('表格行可键盘触发（tabIndex + Enter/Space 切换展开）', async () => {
    render(<AuditLogsPage />);
    const cell = await screen.findByText('user-a');
    const row = cell.closest('tr')!;
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(await screen.findByText('ID')).toBeTruthy();

    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.queryByText('ID')).toBeNull();
  });

  it('批次 F-4：加载失败错误条带「重试」，点击后重新拉取并恢复列表', async () => {
    mockList.mockRejectedValueOnce(new Error('load boom'));
    render(<AuditLogsPage />);

    expect(await screen.findByText('load boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('user-a')).toBeTruthy();
    expect(screen.queryByText('load boom')).toBeNull();
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('批次 F-4：导出成功给 toast 确认；弹窗被拦截时 toast 报错感知', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({} as Window));
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByText('导出已开始，请在浏览器下载中查看')).toBeTruthy();

    openSpy.mockImplementation(() => null);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    expect(await screen.findByText('浏览器拦截了导出弹窗，请允许本站点弹出窗口后重试')).toBeTruthy();
    openSpy.mockRestore();
  });

  it('批次 F-4：空态双语境——真空出「暂无审计日志」+ 来源说明，无「清除筛选」', async () => {
    mockList.mockResolvedValue({
      data: { data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } },
    });
    render(<AuditLogsPage />);

    expect(await screen.findByText('暂无审计日志')).toBeTruthy();
    expect(screen.getByText('系统操作产生后会自动记录在这里')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '清除筛选' })).toBeNull();
  });

  it('批次 F-4：空态双语境——筛选无结果出筛选语境文案 + 「清除筛选」，点击重置筛选重拉', async () => {
    mockList.mockResolvedValue({
      data: { data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } },
    });
    render(<AuditLogsPage />);
    await screen.findByText('暂无审计日志');

    fireEvent.click(screen.getByLabelText('状态筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '失败' }));

    expect(await screen.findByText('没有符合当前筛选条件的日志')).toBeTruthy();
    expect(screen.queryByText('暂无审计日志')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: undefined, page: 1 }),
      ),
    );
    expect(await screen.findByText('暂无审计日志')).toBeTruthy();
  });

  it('stats 子拉取失败：错误行 + 重试，点击后重拉恢复统计卡（原 try/catch 只 console.error 静默）', async () => {
    mockGetStats.mockRejectedValueOnce(new Error('stats boom'));
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(await screen.findByText('stats boom')).toBeTruthy();
    // 失败时统计区不再凭空消失（错误行占位）
    expect(screen.queryByText('总日志数')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('总日志数')).toBeTruthy();
    expect(screen.queryByText('stats boom')).toBeNull();
    await waitFor(() => expect(mockGetStats).toHaveBeenCalledTimes(2));
  });

  it('下拉 options 子拉取失败：错误行 + 重试，点击后重拉恢复筛选项（原 try/catch 只 console.error 静默）', async () => {
    mockListActions.mockRejectedValueOnce(new Error('options boom'));
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(await screen.findByText('options boom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(screen.queryByText('options boom')).toBeNull());
    await waitFor(() => expect(mockListActions).toHaveBeenCalledTimes(2));
    // 恢复后操作筛选下拉带 actions 选项
    fireEvent.click(screen.getByLabelText('操作筛选'));
    expect(await screen.findByRole('option', { name: 'create' })).toBeTruthy();
  });

  it('#591：缺省拉取带 source=all（「全部」语义；后端缺省 operation，需显式传 all），不带 actorType', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    expect(mockList).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'all', actorType: undefined }),
    );
  });

  it('#591：来源筛选——选「Agent 提案」带 source=proposal 并回第 1 页；「操作日志」= operation', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByLabelText('来源筛选'));
    fireEvent.click(await screen.findByRole('option', { name: 'Agent 提案' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ source: 'proposal', page: 1 }),
      ),
    );

    fireEvent.click(screen.getByLabelText('来源筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '操作日志' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ source: 'operation', page: 1 }),
      ),
    );
  });

  it('#591：主体筛选——「人」= human、「Agent」= agent；回「全部」不再带 actorType', async () => {
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByLabelText('主体筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '人' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorType: 'human', page: 1 }),
      ),
    );

    fireEvent.click(screen.getByLabelText('主体筛选'));
    fireEvent.click(await screen.findByRole('option', { name: 'Agent' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorType: 'agent', page: 1 }),
      ),
    );

    fireEvent.click(screen.getByLabelText('主体筛选'));
    fireEvent.click(await screen.findByRole('option', { name: '全部主体' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(
        expect.objectContaining({ actorType: undefined, page: 1 }),
      ),
    );
  });

  it('#591：agent 行用户列带「Agent」标识 badge，人/存量行不带', async () => {
    mockList.mockResolvedValue({
      data: {
        data: [
          ...LOGS,
          { id: 'log-2', action: 'propose', resource: 'distill', status: 'pending', actorType: 'agent', createdAt: '2026-09-08T11:00:00Z' },
        ],
        pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
      },
    });
    render(<AuditLogsPage />);
    const badge = await screen.findByText('Agent');
    expect(badge.className).toContain('rounded');

    const humanCell = screen.getByText('user-a').closest('td')!;
    expect(humanCell.textContent).not.toContain('Agent');
  });

  it('#591：提案行终态 status（pending/executed/rejected/card-failed）走 neutral fallback 不报错', async () => {
    mockList.mockResolvedValue({
      data: {
        data: ['pending', 'executed', 'rejected', 'card-failed'].map((status, i) => ({
          id: `log-p${i}`,
          action: 'propose',
          resource: 'distill',
          status,
          actorType: 'agent',
          createdAt: '2026-09-08T10:00:00Z',
        })),
        pagination: { page: 1, limit: 50, total: 4, totalPages: 1 },
      },
    });
    render(<AuditLogsPage />);

    for (const status of ['pending', 'executed', 'rejected', 'card-failed']) {
      const badge = await screen.findByText(status);
      // neutral fallback（与未知 status 同款 u-surface-2 u-text），不出错不空白
      expect(badge.className).toContain('u-surface-2');
    }
  });

  it('#591：导出带 source/actorType 参数（与列表口径一致）', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({} as Window));
    render(<AuditLogsPage />);
    await screen.findByText('user-a');

    fireEvent.click(screen.getByLabelText('主体筛选'));
    fireEvent.click(await screen.findByRole('option', { name: 'Agent' }));
    await waitFor(() =>
      expect(mockList).toHaveBeenLastCalledWith(expect.objectContaining({ actorType: 'agent' })),
    );

    fireEvent.click(screen.getByRole('button', { name: '导出' }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = openSpy.mock.calls[0][0] as string;
    expect(url).toContain('/audit-logs/export');
    expect(url).toContain('source=all');
    expect(url).toContain('actorType=agent');
    openSpy.mockRestore();
  });
});
