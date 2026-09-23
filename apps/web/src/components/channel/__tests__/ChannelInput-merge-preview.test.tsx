// ChannelInput — #632：发送前三态归属预览条（unique 将并入 / ambiguous 多件在途淡提示 / none 纯消息）。
// 预览仅在「内容非空 + 无 replyTo + 无 @mention + 非发送中」出现，400ms 防抖拉 merge-target；
// 归属选择默认 auto（不发 intent），显式选「新任务」/「纯消息」→ 发送携带 intent，发送成功复位 auto。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockListAgents, mockGetMergeTarget, mockGetFileVocabulary, mockGetChannel } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockGetMergeTarget: vi.fn(),
  mockGetFileVocabulary: vi.fn(),
  mockGetChannel: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
    getMergeTarget: mockGetMergeTarget,
    getFileVocabulary: mockGetFileVocabulary,
    get: mockGetChannel,
  },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';
import { useChannelDataStore } from '../../../stores/channelDataStore';
import type { ChannelMessage } from '../../../api/channel';

const replyTo: ChannelMessage = {
  id: 'm-parent',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'pm-agent',
  content: '上游结论',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
};

function setup(onSend = vi.fn().mockResolvedValue(undefined)) {
  const { container } = render(<ChannelInput onSend={onSend} sending={false} channelId="ch-1" />);
  const textarea = screen.getByPlaceholderText('输入消息，@角色 派单，# 关联 PMO 项目...') as HTMLTextAreaElement;
  return { onSend, textarea, container };
}

function typeIn(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

const previewBar = (container: HTMLElement) => container.querySelector('.mc-input-merge');

describe('ChannelInput — 归属预览条（#632）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: [] } });
    mockGetFileVocabulary.mockResolvedValue({ data: { data: { repos: [] } } });
    mockGetChannel.mockResolvedValue({ data: { data: { members: '[]' } } });
    useChannelDataStore.getState().__resetForTests();
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
    useChannelDataStore.getState().setMembers('ch-1', []);
  });

  it('unique：显示「将并入：<title>」；默认发送不带 intent', async () => {
    mockGetMergeTarget.mockResolvedValue({
      data: { data: { status: 'unique', workUnit: { id: 'wu-1', title: '修登录页样式' } } },
    });
    const { onSend, textarea, container } = setup();

    typeIn(textarea, '补充一点细节');
    await waitFor(() => expect(screen.getByText('将并入：')).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText('修登录页样式')).toBeTruthy();
    expect(previewBar(container)).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // 默认 auto：保旧两参调用形态，不带 intent
    expect(onSend).toHaveBeenCalledWith('补充一点细节', undefined);
  });

  it('unique：选「新任务」后发送带 intent=new-task，发送成功复位 auto', async () => {
    mockGetMergeTarget.mockResolvedValue({
      data: { data: { status: 'unique', workUnit: { id: 'wu-1', title: '修登录页样式' } } },
    });
    const { onSend, textarea } = setup();

    typeIn(textarea, '这是新任务');
    await waitFor(() => expect(screen.getByText('将并入：')).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: '新任务' }));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('这是新任务', undefined, undefined, 'new-task'));

    // 发送成功复位 auto：再发一条回到旧两参形态，不带 intent
    typeIn(textarea, '第二条');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith('第二条', undefined);
  });

  it('unique：选「纯消息」后发送带 intent=plain；再点一次回到 auto', async () => {
    mockGetMergeTarget.mockResolvedValue({
      data: { data: { status: 'unique', workUnit: { id: 'wu-1', title: '修登录页样式' } } },
    });
    const { onSend, textarea } = setup();

    typeIn(textarea, '只是闲聊');
    await waitFor(() => expect(screen.getByText('将并入：')).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(screen.getByRole('button', { name: '纯消息' }));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('只是闲聊', undefined, undefined, 'plain'));
  });

  it('ambiguous：淡提示多件在途，不显示并入目标；可选新任务/纯消息', async () => {
    mockGetMergeTarget.mockResolvedValue({ data: { data: { status: 'ambiguous' } } });
    const { container } = setup();
    const textarea = screen.getByPlaceholderText('输入消息，@角色 派单，# 关联 PMO 项目...') as HTMLTextAreaElement;

    typeIn(textarea, '进度怎么样了');
    await waitFor(
      () => expect(screen.getByText('频道有多件事同时进行，请回复对应消息或 @角色')).toBeTruthy(),
      { timeout: 2000 },
    );
    expect(previewBar(container)).toBeTruthy();
    expect(screen.queryByText('将并入：')).toBeNull();
    expect(screen.getByRole('button', { name: '新任务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '纯消息' })).toBeTruthy();
  });

  it('none：默认归属显示「纯消息」，可选「新任务」', async () => {
    mockGetMergeTarget.mockResolvedValue({ data: { data: { status: 'none' } } });
    const { onSend, container } = setup();
    const textarea = screen.getByPlaceholderText('输入消息，@角色 派单，# 关联 PMO 项目...') as HTMLTextAreaElement;

    typeIn(textarea, '随便聊聊');
    await waitFor(() => expect(previewBar(container)).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByRole('button', { name: '新任务' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新任务' }));
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('随便聊聊', undefined, undefined, 'new-task'));
  });

  it('内容含 @mention → 不显示预览条，也不拉取 merge-target', async () => {
    mockGetMergeTarget.mockResolvedValue({
      data: { data: { status: 'unique', workUnit: { id: 'wu-1', title: 'x' } } },
    });
    const { container } = setup();
    const textarea = screen.getByPlaceholderText('输入消息，@角色 派单，# 关联 PMO 项目...') as HTMLTextAreaElement;

    typeIn(textarea, '@pm-agent 看一下这个');
    await new Promise(r => setTimeout(r, 600));
    expect(previewBar(container)).toBeNull();
    expect(mockGetMergeTarget).not.toHaveBeenCalled();
  });

  it('replyTo 回复中 → 不显示预览条', async () => {
    mockGetMergeTarget.mockResolvedValue({
      data: { data: { status: 'unique', workUnit: { id: 'wu-1', title: 'x' } } },
    });
    const { container } = render(
      <ChannelInput onSend={vi.fn()} sending={false} channelId="ch-1" replyTo={replyTo} onCancelReply={vi.fn()} />,
    );
    const textarea = screen.getByPlaceholderText('输入消息，@角色 派单，# 关联 PMO 项目...') as HTMLTextAreaElement;

    typeIn(textarea, '线程里补充');
    await new Promise(r => setTimeout(r, 600));
    expect(previewBar(container)).toBeNull();
    expect(mockGetMergeTarget).not.toHaveBeenCalled();
  });
});
