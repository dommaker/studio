// 工单 38: KnowledgePage 手动新建条目 — 失败 toast 反馈且表单保留（原先仅 console.error 静默）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockListUnified, mockCreateUnifiedEntry, mockPromote, mockDemote, mockSearch } = vi.hoisted(() => ({
  mockListUnified: vi.fn(),
  mockCreateUnifiedEntry: vi.fn(),
  mockPromote: vi.fn(),
  mockDemote: vi.fn(),
  mockSearch: vi.fn(),
}));

vi.mock('../../api/knowledge', () => ({
  knowledgeApi: {
    listUnified: mockListUnified,
    createUnifiedEntry: mockCreateUnifiedEntry,
    promote: mockPromote,
    demote: mockDemote,
    listGaps: vi.fn().mockResolvedValue({ data: { data: [] } }),
    listResolutions: vi.fn().mockResolvedValue({ data: { resolutions: [] } }),
    search: mockSearch,
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

describe('E5: 待审筛选 + draft 条目审批（promote/demote）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockResolvedValue({ data: { results: [] } });
    mockPromote.mockResolvedValue({ data: {} });
    mockDemote.mockResolvedValue({ data: {} });
  });

  it('「待审」筛选以 maturity=draft 调 listUnified；draft 条目带成熟度徽标与卡底「通过/拒绝」', async () => {
    mockListUnified.mockResolvedValue({
      data: {
        entries: [
          { id: 'd1', title: '待审条目', consumptionMode: 'rule', source: 'extractor', content: '短内容', tags: [], maturity: 'draft' },
          { id: 'v1', title: '已审条目', consumptionMode: 'rule', source: 'extractor', content: '短内容', tags: [], maturity: 'verified' },
        ],
        total: 2,
      },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    // 成熟度徽标上屏（draft 待审 warning 色，verified accent 色）
    const draftBadge = await screen.findByText('draft');
    expect(draftBadge.className).toContain('u-warn-bg');
    expect(screen.getByText('verified').className).toContain('u-accent-bg');
    // draft 条目卡底有「通过 / 拒绝」，verified 条目没有
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();

    fireEvent.click(screen.getByText('待审'));
    await waitFor(() => expect(mockListUnified).toHaveBeenCalledWith(
      expect.objectContaining({ maturity: 'draft', offset: 0 }),
    ));
  });

  it('点「通过」调 promote 并把条目移出列表；点「拒绝」调 demote', async () => {
    mockListUnified.mockResolvedValue({
      data: {
        entries: [
          { id: 'd1', title: '待审条目甲', consumptionMode: 'rule', source: 's', content: 'x', tags: [], maturity: 'draft' },
          { id: 'd2', title: '待审条目乙', consumptionMode: 'rule', source: 's', content: 'x', tags: [], maturity: 'draft' },
        ],
        total: 2,
      },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    const approveBtns = await screen.findAllByText('通过');
    fireEvent.click(approveBtns[0]);
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith('d1'));
    // 成功后移出列表（maturity 已变，不再是当前视图成员）
    await waitFor(() => expect(screen.queryByText('待审条目甲')).toBeNull());
    expect(screen.getByText('待审条目乙')).toBeTruthy();

    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(mockDemote).toHaveBeenCalledWith('d2'));
    await waitFor(() => expect(screen.queryByText('待审条目乙')).toBeNull());
  });

  it('审批失败 toast 报错（服务端 error.message 优先）且条目保留可重试', async () => {
    mockListUnified.mockResolvedValue({
      data: {
        entries: [{ id: 'd1', title: '待审条目', consumptionMode: 'rule', source: 's', content: 'x', tags: [], maturity: 'draft' }],
        total: 1,
      },
    });
    mockPromote.mockRejectedValue(new Error('network down'));
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('通过'));
    expect(await screen.findByText('通过失败，请重试')).toBeTruthy();
    // 条目保留在列表中可重试
    expect(screen.getByText('待审条目')).toBeTruthy();
  });
});

describe('E5: 搜索态替换 tab 内容区', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUnified.mockResolvedValue({
      data: { entries: [{ id: 'e1', title: '普通条目', consumptionMode: 'rule', source: 's', content: 'x', tags: [] }], total: 1 },
    });
  });

  it('搜索后结果替换 tab 内容区（tab 栏与条目列表不并存），「清除」返回 tab 视图', async () => {
    mockSearch.mockResolvedValue({
      data: { results: [{ type: 'resolution', id: 'r1', title: '命中结果', snippet: '片段', score: 0.9 }] },
    });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    expect(await screen.findByText('普通条目')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/全局搜索知识/), { target: { value: '解法' } });
    fireEvent.click(screen.getByText('搜索'));

    expect(await screen.findByText('命中结果')).toBeTruthy();
    // 搜索态：tab 栏与 tab 内容区被替换
    expect(screen.queryByText('普通条目')).toBeNull();
    expect(screen.queryByText('统一视图')).toBeNull();
    // 结果类型徽标去 emoji，纯文字
    expect(screen.getByText('resolution')).toBeTruthy();

    fireEvent.click(screen.getByText('清除'));
    expect(await screen.findByText('普通条目')).toBeTruthy();
    expect(screen.getByText('统一视图')).toBeTruthy();
  });

  it('搜索无结果时搜索态内出空态，而非静默回 tab 视图', async () => {
    mockSearch.mockResolvedValue({ data: { results: [] } });
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    fireEvent.change(screen.getByPlaceholderText(/全局搜索知识/), { target: { value: '不存在' } });
    fireEvent.click(screen.getByText('搜索'));

    expect(await screen.findByText('无匹配结果')).toBeTruthy();
    expect(screen.queryByText('统一视图')).toBeNull();
  });
});

describe('E5: 「加载更多」真追加（对齐 E2 WU 列表口径）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockResolvedValue({ data: { results: [] } });
  });

  it('加载更多按 offset 累加拼接（非翻页替换），页脚出「已加载 X / 共 N」', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `p1-${i}`, title: `首页条目${i}`, consumptionMode: 'rule', source: 's', content: 'x', tags: [],
    }));
    mockListUnified.mockImplementation(({ offset = 0 }: { offset?: number }) => Promise.resolve({
      data: offset === 0
        ? { entries: page1, total: 51 }
        : { entries: [{ id: 'p2-0', title: '追加条目', consumptionMode: 'rule', source: 's', content: 'x', tags: [] }], total: 51 },
    }));
    render(<MemoryRouter><KnowledgePage /></MemoryRouter>);

    expect(await screen.findByText('首页条目0')).toBeTruthy();
    expect(screen.getByText('已加载 50 / 共 51')).toBeTruthy();

    fireEvent.click(screen.getByText('加载更多'));
    await waitFor(() => expect(mockListUnified).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 })));

    // 追加：首页条目仍在，新页条目拼上
    expect(await screen.findByText('追加条目')).toBeTruthy();
    expect(screen.getByText('首页条目0')).toBeTruthy();
    expect(screen.getByText('已加载 51 / 共 51')).toBeTruthy();
    // 全部加载完后「加载更多」消失
    expect(screen.queryByText('加载更多')).toBeNull();
  });
});
