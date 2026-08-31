/**
 * ChannelMessageItem tests — F5: NEED_INPUT 挂起「等待回复」badge
 * + 2026-07 §5.7: WU ↗ 直跳 / PMO chip 渲染与跳转
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// 卡片子组件与本测试无关，避免其内部 API 依赖
vi.mock('../channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelMessageItem } from '../channel/ChannelMessageItem';
import type { ChannelMessage } from '../../api/channel';

const baseMessage: ChannelMessage = {
  id: 'msg-1',
  channelId: 'ch-1',
  workUnitId: 'wu-1',
  authorType: 'agent',
  agentName: 'f5-agent',
  content: '需要输入: 使用 OAuth 还是账号密码？',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('ChannelMessageItem — F5 waiting badge', () => {
  it('shows 等待回复 badge when waitingForInput', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
  });

  it('does not show badge by default', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} />);
    expect(screen.queryByText('等待回复')).not.toBeInTheDocument();
  });

  // #279（走查 F4）+ #276（P2 #15）：回答后「已回复」与「等待回复」不得同屏并存；
  // #276：needSent 不再点击即置位--仅在 onInlineReply await resolve 后置位，
  // 发送失败不发「已回复」假承诺；「已回复」文本去掉「WorkUnit 将继续执行」未来时承诺。
  it('#276 发送成功 -> 显示已回复，badge 让位（互斥；不再点击即假承诺）', async () => {
    let resolveReply: () => void = () => {};
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveReply = resolve; }),
    );
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.click(screen.getByText('回复'));
    // 发送期间：button 显示「发送中…」、input 禁用
    await waitFor(() => expect(screen.getByText('发送中…')).toBeInTheDocument());
    expect((screen.getByLabelText('回复 wu-1') as HTMLInputElement).disabled).toBe(true);
    // await resolve 后：needSent=true -> 已回复，badge 消失（互斥）
    resolveReply();
    expect(await screen.findByText(/已回复/)).toBeInTheDocument();
    expect(screen.queryByText('等待回复')).not.toBeInTheDocument();
  });

  // #276 AC1：发送失败 -> 不发假承诺「已回复」，表单恢复可用可重试
  it('#276 发送失败 -> 不显示已回复，表单恢复可用', async () => {
    let rejectReply: ((err: Error) => void) | null = null;
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>((_, reject) => { rejectReply = reject; }),
    );
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.click(screen.getByText('回复'));
    // 发送中：button 显示「发送中…」、input 禁用
    await waitFor(() => expect(screen.getByText('发送中…')).toBeInTheDocument());
    expect((screen.getByLabelText('回复 wu-1') as HTMLInputElement).disabled).toBe(true);
    // 模拟失败
    rejectReply!(new Error('network'));
    // 失败后：needSent 保持 false，表单恢复可用，未发假承诺
    await waitFor(() => expect(screen.getByText('回复')).toBeInTheDocument());
    expect((screen.getByLabelText('回复 wu-1') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/已回复/)).not.toBeInTheDocument();
    expect(screen.getByText('等待回复')).toBeInTheDocument();
  });

  // #276 AC1：文案不再含未来时假承诺「WorkUnit 将继续执行」
  it('#276 文案不再含「WorkUnit 将继续执行」假承诺（已回复文本 + placeholder）', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.queryByText(/WorkUnit 将继续执行/)).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText(/直接在此回复/) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).not.toMatch(/WorkUnit 将继续执行/);
  });

  // #276 AC1：发送中（needSending）防 re-entry 重复触发
  it('#276 发送中再次 Enter 不重复触发 onInlineReply', async () => {
    let resolveReply: () => void = () => {};
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveReply = resolve; }),
    );
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.keyDown(screen.getByLabelText('回复 wu-1'), { key: 'Enter' });
    await waitFor(() => expect(onInlineReply).toHaveBeenCalledTimes(1));
    // 再次 Enter：needSending 守卫，不重复调用
    fireEvent.keyDown(screen.getByLabelText('回复 wu-1'), { key: 'Enter' });
    expect(onInlineReply).toHaveBeenCalledTimes(1);
    resolveReply();
    await waitFor(() => expect(screen.getByText(/已回复/)).toBeInTheDocument());
  });

  // #276 AC1：以 WU 真实状态为准——回复成功后 WU 复活又再度挂起（仍是本条提问），
  // needSent 重置回到「等待回复」态，可再次回复（列表 key={msg.id} 不重挂载，须显式重置）
  it('#276 WU 再度挂起 -> 回到等待回复态（needSent 重置）', async () => {
    let resolveReply: () => void = () => {};
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveReply = resolve; }),
    );
    const { rerender } = render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.click(screen.getByText('回复'));
    resolveReply();
    expect(await screen.findByText(/已回复/)).toBeInTheDocument();
    // WU 复活 -> 等待区整体收起
    rerender(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput={false} onInlineReply={onInlineReply} />);
    expect(screen.queryByText(/已回复/)).not.toBeInTheDocument();
    // WU 再度挂起（无新提问，仍落本条）-> 回到等待回复态，表单可再次使用
    rerender(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
    expect(screen.getByLabelText('回复 wu-1')).toBeInTheDocument();
    expect(screen.queryByText(/已回复/)).not.toBeInTheDocument();
  });

  // #276 AC1：发送失败保留已输入内容，便于直接重试
  it('#276 发送失败 -> draft 保留可重试', async () => {
    let rejectReply: ((err: Error) => void) | null = null;
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>((_, reject) => { rejectReply = reject; }),
    );
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.click(screen.getByText('回复'));
    await waitFor(() => expect(screen.getByText('发送中…')).toBeInTheDocument());
    rejectReply!(new Error('network'));
    await waitFor(() => expect(screen.getByText('回复')).toBeInTheDocument());
    expect((screen.getByLabelText('回复 wu-1') as HTMLInputElement).value).toBe('用 OAuth');
  });

  // #279（决策 #250 D4）：顶栏 chip 定位高亮——highlight prop 挂 mc-msg-highlight class
  it('highlight prop → 消息根元素带 mc-msg-highlight class', () => {
    const { container } = render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} highlight />);
    expect(container.querySelector('.mc-msg.mc-msg-highlight')).toBeTruthy();
    expect(container.querySelector('[data-message-id="msg-1"]')).toBeTruthy();
  });
});

describe('ChannelMessageItem — §5.7 WU/PMO 直跳', () => {
  it('有 workUnitId 时渲染 ↗，点击跳 /workunits/:id', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTitle('新页面打开任务详情'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-1');
  });

  it('无 workUnitId 时不渲染 ↗', () => {
    render(<ChannelMessageItem message={{ ...baseMessage, workUnitId: null }} onAction={vi.fn()} />);
    expect(screen.queryByTitle('新页面打开任务详情')).not.toBeInTheDocument();
  });

  it('meta.pmoId 存在时渲染 PMO chip，点击跳 /pmo/project/:id', () => {
    const msg: ChannelMessage = { ...baseMessage, meta: JSON.stringify({ pmoId: 'proj-1' }) };
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTitle('打开项目详情'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-1');
  });

  it('老消息 meta 无 pmoId 时不渲染 PMO chip', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} />);
    expect(screen.queryByTitle('打开项目详情')).not.toBeInTheDocument();
  });

  it('meta 缺失/非法 JSON 时不渲染 PMO chip（防御）', () => {
    const noMeta: ChannelMessage = { ...baseMessage, meta: undefined };
    render(<ChannelMessageItem message={noMeta} onAction={vi.fn()} />);
    expect(screen.queryByTitle('打开项目详情')).not.toBeInTheDocument();

    const badMeta: ChannelMessage = { ...baseMessage, meta: '{broken' };
    render(<ChannelMessageItem message={badMeta} onAction={vi.fn()} />);
    expect(screen.queryByTitle('打开项目详情')).not.toBeInTheDocument();
  });
});

describe('ChannelMessageItem — #264 object meta 双型兼容（线上 REST/SSE 出口为 object）', () => {
  it('meta 为 object 时人审卡正常渲染为卡片（非纯文本）', () => {
    const msg: ChannelMessage = {
      ...baseMessage,
      content: '知识提案 — 待人工审核',
      meta: {
        cardType: 'knowledge_proposal',
        status: 'ready',
        cardData: { entries: [{ id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' }] },
      },
    };
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} />);
    // 卡片渲染出审批按钮；纯文本回退时只显示 content，无按钮
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('meta 为 string 时行为不变（存量形态回归）', () => {
    const msg: ChannelMessage = {
      ...baseMessage,
      content: '知识提案 — 待人工审核',
      meta: JSON.stringify({
        cardType: 'knowledge_proposal',
        status: 'ready',
        cardData: { entries: [{ id: 'k-1', title: 'session 过期未刷新导致 401', type: 'pitfall' }] },
      }),
    };
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} />);
    expect(screen.getByText('通过')).toBeTruthy();
  });

  it('meta 为 object 且含 pmoId 时渲染 PMO chip，点击跳 /pmo/project/:id', () => {
    const msg: ChannelMessage = { ...baseMessage, meta: { pmoId: 'proj-9' } };
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTitle('打开项目详情'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-9');
  });
});

describe('ChannelMessageItem — #267 NEED_INPUT 结构化选项卡（meta.options[]）', () => {
  const optionsMessage = (meta: ChannelMessage['meta']): ChannelMessage => ({
    ...baseMessage,
    agentName: 'Studio',
    content: '任务「改一下登录页」匹配到多个工程，请回复其中一个',
    meta,
  });
  const OPTIONS = [
    { label: 'studio', description: '/root/projects/studio', value: '/root/projects/studio' },
    { label: 'studio-config', description: '/root/projects/studio-config', value: '/root/projects/studio-config' },
  ];

  it('waitingForInput + object meta 带 options → 渲染选项卡而非纯文本列表', () => {
    render(<ChannelMessageItem message={optionsMessage({ options: OPTIONS })} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.getByText('studio')).toBeTruthy();
    expect(screen.getByText('/root/projects/studio-config')).toBeTruthy();
    expect(screen.getByText('自定义…')).toBeTruthy();
    expect(screen.getByText('交给 agent 判断')).toBeTruthy();
    // 默认不渲染单行回复输入（收起进「自定义…」）
    expect(screen.queryByPlaceholderText(/直接在此回复/)).toBeNull();
  });

  it('点选选项 → onInlineReply(message, value) 走现有内嵌回复通道', async () => {
    const onInlineReply = vi.fn();
    const msg = optionsMessage({ options: OPTIONS });
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    // #276：点击后经 async 微任务置位状态，act 包裹 flush 微任务
    await act(async () => {
      fireEvent.click(screen.getByText('studio-config'));
    });
    expect(onInlineReply).toHaveBeenCalledWith(msg, '/root/projects/studio-config');
  });

  // #276：选项卡发送成功 -> needSent 置位 -> 收起为已回复提示
  it('#276 选项卡发送成功 -> 收起为已回复提示', async () => {
    const onInlineReply = vi.fn().mockResolvedValue(undefined);
    render(<ChannelMessageItem message={optionsMessage({ options: OPTIONS })} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.click(screen.getByText('studio'));
    // await resolve 后：needSent=true -> 已回复，选项卡收起
    expect(await screen.findByText(/已回复/)).toBeTruthy();
    expect(screen.queryByText('studio-config')).toBeNull();
  });

  // #276 AC1：选项卡发送失败 -> 选项卡恢复可用，未发假承诺
  it('#276 选项卡发送失败 -> 不显示已回复，选项恢复可点', async () => {
    let rejectReply: ((err: Error) => void) | null = null;
    const onInlineReply = vi.fn().mockImplementation(
      () => new Promise<void>((_, reject) => { rejectReply = reject; }),
    );
    render(<ChannelMessageItem message={optionsMessage({ options: OPTIONS })} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.click(screen.getByText('studio'));
    // 发送中：选项禁用
    await waitFor(() => expect((screen.getByText('studio-config').closest('button') as HTMLButtonElement).disabled).toBe(true));
    rejectReply!(new Error('network'));
    // 失败后：选项恢复可点，未发假承诺
    await waitFor(() => expect((screen.getByText('studio-config').closest('button') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/已回复/)).not.toBeInTheDocument();
  });

  it('string 形态 meta 带 options 同样渲染（存量形态回归）', () => {
    render(<ChannelMessageItem message={optionsMessage(JSON.stringify({ options: OPTIONS }))} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.getByText('studio')).toBeTruthy();
  });

  it('无 options 时保持现有单行回复框 fallback', () => {
    render(<ChannelMessageItem message={optionsMessage({})} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.getByPlaceholderText(/直接在此回复/)).toBeTruthy();
    expect(screen.queryByText('自定义…')).toBeNull();
  });

  it('options 元素非法（缺 label）时防御性过滤，不崩溃', () => {
    const msg = optionsMessage({ options: [{ description: '/x' }, { label: 'studio' }] });
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.getByText('studio')).toBeTruthy();
    expect(screen.queryByText('/x')).toBeNull();
  });
});

describe('ChannelMessageItem — #241 footer WU 链接截短显示', () => {  it('长 UUID 截短为前 8 位 + …，title 保留全量 id', () => {
    const uuid = '160eeee8-aaaa-bbbb-cccc-dddddddddddd';
    render(<ChannelMessageItem message={{ ...baseMessage, workUnitId: uuid }} onAction={vi.fn()} onOpenWorkUnit={vi.fn()} />);
    const link = screen.getByTitle(`打开任务详情：${uuid}`);
    expect(link.textContent).toBe('160eeee8… ›');
  });

  it('短 id（WU-N 形态）原样显示不截短', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} onOpenWorkUnit={vi.fn()} />);
    expect(screen.getByText('wu-1 ›')).toBeTruthy();
  });
});

describe('ChannelMessageItem — #278 D5 机制派生回执 = 系统播报形态（视觉归 #248 D3）', () => {
  // 机制派生回执（analysis 拆任务清单 / 开图结果 / 「不自动派生」提示）：
  // 后端 createAgentMessage(channelId, 'Studio', ...) 无卡非等待 → 居中淡色小字 mc-msg-system
  const receipt = (content: string): ChannelMessage => ({
    ...baseMessage,
    agentName: 'Studio',
    workUnitId: 'wu-9',
    content,
    meta: '{}',
  });

  it('Studio 署名无卡消息（带 workUnitId 的派生回执）渲染为 mc-msg-system 且无消息头', () => {
    const { container } = render(
      <ChannelMessageItem
        message={receipt('分析结论已确认。未输出 TASK 拆分行，不自动派生；可手动建单')}
        onAction={vi.fn()}
      />,
    );
    expect(container.querySelector('.mc-msg-system')).toBeTruthy();
    expect(container.querySelector('.mc-msg-head')).toBeNull();
    expect(container.querySelector('.mc-msg-agent')).toBeNull();
    expect(screen.getByText(/不自动派生/)).toBeTruthy();
  });

  it('卡片消息不归系统播报（全宽卡片形态优先）', () => {
    const { container } = render(
      <ChannelMessageItem
        message={{
          ...receipt('审计建议 — 1 条'),
          meta: JSON.stringify({ cardType: 'auditor_suggestion', status: 'ready', cardData: { suggestions: [] } }),
        }}
        onAction={vi.fn()}
      />,
    );
    expect(container.querySelector('.mc-msg-system')).toBeNull();
    expect(container.querySelector('.mc-msg-card')).toBeTruthy();
  });
});
