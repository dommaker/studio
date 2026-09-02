// 工单 38: KnowledgePage 手动新建条目 — 失败 toast 反馈且表单保留（原先仅 console.error 静默）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockListUnified, mockCreateUnifiedEntry } = vi.hoisted(() => ({
  mockListUnified: vi.fn(),
  mockCreateUnifiedEntry: vi.fn(),
}));

vi.mock('../../api/knowledge', () => ({
  knowledgeApi: {
    listUnified: mockListUnified,
    createUnifiedEntry: mockCreateUnifiedEntry,
    listGaps: vi.fn().mockResolvedValue({ data: { data: [] } }),
    listResolutions: vi.fn().mockResolvedValue({ data: { resolutions: [] } }),
    search: vi.fn().mockResolvedValue({ data: { results: [] } }),
  },
}));

vi.mock('../../api/maintenance', () => ({
  maintenanceApi: {
    getCosts: vi.fn().mockResolvedValue(null),
    runKnowledgeMaintenance: vi.fn(),
    fireTrigger: vi.fn(),
  },
}));

import { KnowledgePage } from '../KnowledgePage';

describe('工单 38: KnowledgePage 新建条目失败反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUnified.mockResolvedValue({ data: { entries: [], total: 0 } });
  });

  it('创建失败时 toast 报错、表单保留且内容不清空', async () => {
    mockCreateUnifiedEntry.mockRejectedValue(new Error('server down'));
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '踩坑记录' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '不要在生产环境直接改库' } });
    fireEvent.click(screen.getByText('保存'));

    // toast.error 兜底文案（toast 挂在 document.body）
    expect(await screen.findByText('server down')).toBeTruthy();
    // 表单不关闭、输入内容保留，用户可修正后重试
    expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('踩坑记录');
    expect((screen.getByPlaceholderText('内容') as HTMLTextAreaElement).value).toBe('不要在生产环境直接改库');
  });

  it('创建成功后关闭表单并刷新列表', async () => {
    mockCreateUnifiedEntry.mockResolvedValue({ data: {} });
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '指南' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '内容' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
    expect(mockCreateUnifiedEntry).toHaveBeenCalledTimes(1);
    // 初次加载 + 成功后刷新各一次
    await waitFor(() => expect(mockListUnified).toHaveBeenCalledTimes(2));
  });

  it('提交中保存按钮禁用（loading 态），连点只提交一次', async () => {
    let resolveCreate: (v: unknown) => void;
    mockCreateUnifiedEntry.mockImplementation(
      () => new Promise(resolve => { resolveCreate = resolve; })
    );
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '指南' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '内容' } });

    fireEvent.click(screen.getByText('保存'));
    fireEvent.click(screen.getByText('保存中...'));

    expect(mockCreateUnifiedEntry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('保存中...').closest('button')!.disabled).toBe(true);

    resolveCreate!({ data: {} });
    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
  });
});

describe('#435: 统一视图内容消化 + 徽标类别色 + 占位符', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('JSON 内容条目结构化键值呈现，不裸出存储层原文', async () => {
    mockListUnified.mockResolvedValue({
      data: {
        entries: [{
          id: 'e1', title: '用户偏好', consumptionMode: 'context', source: 'preference-extractor',
          content: '{"responseStyle":"简洁","preferredModel":"k2"}', tags: [],
        }],
        total: 1,
      },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    expect(await screen.findByText('responseStyle')).toBeTruthy();
    expect(screen.getByText('简洁')).toBeTruthy();
    // 裸 JSON 原文（带括号引号的存储层形态）不再出现
    expect(screen.queryByText(/\{"responseStyle"/)).toBeNull();
  });

  it('长文本截断 200 字符，点击展开显示全文', async () => {
    const longText = '告警：Agent 执行失败。'.repeat(30); // >200 字符
    mockListUnified.mockResolvedValue({
      data: {
        entries: [{ id: 'e2', title: 'Monitor 告警', consumptionMode: 'signal', source: 'monitor', content: longText, tags: [] }],
        total: 1,
      },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    const toggle = await screen.findByText('展开');
    expect(screen.queryByText(longText)).toBeNull(); // 默认不直出全文
    fireEvent.click(toggle);
    expect(screen.getByText(longText)).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText(longText)).toBeNull();
  });

  it('consumptionMode 徽标用 chart 类别色，不占 err/warn/accent 状态色', async () => {
    mockListUnified.mockResolvedValue({
      data: {
        entries: [
          { id: 'e3', title: 'r', consumptionMode: 'rule', source: 's', content: 'x', tags: [] },
          { id: 'e4', title: 's', consumptionMode: 'signal', source: 's', content: 'x', tags: [] },
          { id: 'e5', title: 'c', consumptionMode: 'context', source: 's', content: 'x', tags: [] },
        ],
        total: 3,
      },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    const rule = await screen.findByText('rule');
    expect(rule.style.color).toBe('var(--chart-2)');
    expect(rule.className).not.toMatch(/u-err-bg|u-warn-bg|u-accent-bg/);
    expect(screen.getByText('signal').style.color).toBe('var(--chart-7)');
    expect(screen.getByText('context').style.color).toBe('var(--chart-1)');
  });

  it('搜索占位符不含已删类型「行为模式」', () => {
    mockListUnified.mockResolvedValue({ data: { entries: [], total: 0 } });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);
    expect(screen.queryByPlaceholderText(/行为模式/)).toBeNull();
  });
});
