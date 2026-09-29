// ChannelInput — #638 派单语法引导：
// 1) `#` 触发 PMO 自动补全弹框（候选 = 当前 PMO 置顶 + 挂接 REQ 所属 PMO，seq 降序去重）；
//    选中插入 `#PMO-n `（带尾随空格，与后端 req-binding PMO_TOKEN_RE /#(PMO?-\d+)/i 同形）
// 2) placeholder 提及 @角色 派单
// 交互语义与 @ 弹框对齐：键盘循环导航 / Enter·Tab 选中 / Esc dismiss（继续输入复位）/ IME 守卫；
// 候选缺键或空数组 → fail-closed 不出弹框。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { mockGetPmoCandidates, mockGetCurrentPmo, mockGetFileVocabulary, mockChannelGet, mockGetMergeTarget } = vi.hoisted(() => ({
  mockGetPmoCandidates: vi.fn(),
  mockGetCurrentPmo: vi.fn(),
  mockGetFileVocabulary: vi.fn(),
  mockChannelGet: vi.fn(),
  mockGetMergeTarget: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    getPmoCandidates: mockGetPmoCandidates,
    getCurrentPmo: mockGetCurrentPmo,
    getFileVocabulary: mockGetFileVocabulary,
    get: mockChannelGet,
    getMergeTarget: mockGetMergeTarget,
  },
}));

import { ChannelInput } from '../ChannelInput';
import { useChannelDataStore } from '../../../stores/channelDataStore';
import { useRosterStore } from '../../../stores/rosterStore';

const PLACEHOLDER = '输入消息，@角色 派单，# 关联 PMO 项目...';

// 后端契约：当前 PMO（proj-b）置顶
const candidates = [
  { id: 'proj-b', pmoNumber: 'PMO-2', title: '订单链路' },
  { id: 'proj-a', pmoNumber: 'PMO-1', title: '商城重构' },
];
const currentPmo = { id: 'proj-b', pmoNumber: 'PMO-2', title: '订单链路', gitRepos: [] };

function setup() {
  const onSend = vi.fn();
  const { container } = render(<ChannelInput onSend={onSend} sending={false} channelId="ch-1" />);
  const textarea = screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  return { onSend, textarea, container };
}

const pmoPopup = () => screen.queryByRole('listbox', { name: 'PMO 项目候选' });

async function openPmoPopup(textarea: HTMLTextAreaElement, value = '#') {
  fireEvent.change(textarea, { target: { value } });
  const popup = await screen.findByRole('listbox', { name: 'PMO 项目候选' });
  return popup;
}

describe('ChannelInput — # 触发 PMO 自动补全（#638）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelDataStore.getState().__resetForTests();
    // agent 列表读 rosterStore 客户端切片：seed 空正本 + fresh TTL 锚点（ensureFresh 零请求）
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
    mockGetPmoCandidates.mockResolvedValue({ data: { success: true, data: candidates } });
    mockGetCurrentPmo.mockResolvedValue({ data: { success: true, data: currentPmo } });
    mockGetFileVocabulary.mockResolvedValue({ data: { success: true, data: { repos: [] } } });
    mockChannelGet.mockResolvedValue({ data: { success: true, data: { id: 'ch-1', members: '[]' } } });
    // 归属预览与本特性无关：永不 resolve，避免干扰断言
    mockGetMergeTarget.mockReturnValue(new Promise(() => {}));
  });

  it('placeholder 提及 @角色 派单', () => {
    const { textarea } = setup();
    expect(textarea.placeholder).toContain('@角色 派单');
  });

  it('打 # 出弹框：当前 PMO 在列排第一并带「当前」标记，懒加载拉取候选', async () => {
    const { textarea } = setup();
    const popup = await openPmoPopup(textarea);

    await waitFor(() => expect(mockGetPmoCandidates).toHaveBeenCalledWith('ch-1'));
    const options = within(popup).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('#PMO-2');
    expect(options[0].textContent).toContain('订单链路');
    await within(popup).findByText('当前');
    expect(options[0].textContent).toContain('当前');
    expect(options[1].textContent).toContain('#PMO-1');
    expect(options[1].textContent).not.toContain('当前');
  });

  it('继续输入字符过滤候选：按 pmoNumber 与 title 匹配', async () => {
    const { textarea } = setup();

    // pmoNumber 匹配（大小写不敏感）
    let popup = await openPmoPopup(textarea, '#2');
    await waitFor(() => {
      const options = within(pmoPopup()!).getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain('#PMO-2');
    });

    // title 匹配
    fireEvent.change(textarea, { target: { value: '#商城' } });
    await waitFor(() => {
      const options = within(pmoPopup()!).getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toContain('#PMO-1');
    });
    popup = pmoPopup()!;
    expect(popup).toBeTruthy();
  });

  it('Enter 选中首项插入 `#PMO-n `（带尾随空格），光标落在空格后；文本匹配后端 PMO_TOKEN_RE', async () => {
    const { textarea } = setup();
    await openPmoPopup(textarea);

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('#PMO-2 ');
    expect(textarea.value).toMatch(/#(PMO?-\d+)/i);
    await waitFor(() => expect(textarea.selectionStart).toBe('#PMO-2 '.length));
    // 插入后弹框关闭（query 含空格）
    expect(pmoPopup()).toBeNull();
  });

  it('键盘导航循环 + Enter 选中目标项', async () => {
    const { textarea } = setup();
    const popup = await openPmoPopup(textarea);
    const options = () => within(pmoPopup()!).getAllByRole('option');

    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    // 到底再 Down 循环回首项
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    // 首项 Up 循环到末项
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('#PMO-1 ');
    expect(popup).toBeTruthy();
  });

  it('点击（mouseDown）选中插入', async () => {
    const { textarea } = setup();
    const popup = await openPmoPopup(textarea);

    fireEvent.mouseDown(within(popup).getAllByRole('option')[1]);
    expect(textarea.value).toBe('#PMO-1 ');
    expect(textarea.value).toMatch(/#(PMO?-\d+)/i);
  });

  it('Esc dismiss：弹框关闭、内容不动；继续输入表达新意图 → 弹框重开', async () => {
    const { textarea } = setup();
    await openPmoPopup(textarea);

    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(pmoPopup()).toBeNull();
    expect(textarea.value).toBe('#');

    fireEvent.change(textarea, { target: { value: '#P' } });
    await screen.findByRole('listbox', { name: 'PMO 项目候选' });
    expect(pmoPopup()).toBeTruthy();
  });

  it('IME 合成中的 Enter（isComposing / keyCode 229）不选中候选', async () => {
    const { onSend, textarea } = setup();
    await openPmoPopup(textarea);

    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(textarea.value).toBe('#');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(textarea.value).toBe('#');
    expect(onSend).not.toHaveBeenCalled();
    expect(pmoPopup()).toBeTruthy();
  });

  it('无候选（后端空数组）→ fail-closed 不出弹框', async () => {
    mockGetPmoCandidates.mockResolvedValue({ data: { success: true, data: [] } });
    const { textarea } = setup();

    fireEvent.change(textarea, { target: { value: '#' } });
    await waitFor(() => {
      expect(useChannelDataStore.getState().pmoCandidates['ch-1']).toEqual([]);
    });
    expect(pmoPopup()).toBeNull();
  });

  it('候选缺键（拉取失败不落数据）→ fail-closed 不出弹框', async () => {
    mockGetPmoCandidates.mockRejectedValue(new Error('boom'));
    const { textarea } = setup();

    fireEvent.change(textarea, { target: { value: '#' } });
    await waitFor(() => expect(mockGetPmoCandidates).toHaveBeenCalledWith('ch-1'));
    expect(useChannelDataStore.getState().pmoCandidates['ch-1']).toBeUndefined();
    expect(pmoPopup()).toBeNull();
  });
});
