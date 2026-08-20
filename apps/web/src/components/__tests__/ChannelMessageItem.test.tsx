/**
 * ChannelMessageItem tests — F5: NEED_INPUT 挂起「等待回复」badge
 * + 2026-07 §5.7: WU ↗ 直跳 / PMO chip 渲染与跳转
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// 卡片子组件与本测试无关，避免其内部 API 依赖
vi.mock('../channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
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

  // #279（走查 F4）：回答后「已回复」与「等待回复」不得同屏并存——badge 让位给已回复提示
  it('发送内嵌回复后 badge 让位：只显示已回复，不再同屏并存', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回复 wu-1'), { target: { value: '用 OAuth' } });
    fireEvent.click(screen.getByText('回复'));
    expect(screen.getByText(/已回复/)).toBeInTheDocument();
    expect(screen.queryByText('等待回复')).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByTitle('新页面打开 WorkUnit 详情'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-1');
  });

  it('无 workUnitId 时不渲染 ↗', () => {
    render(<ChannelMessageItem message={{ ...baseMessage, workUnitId: null }} onAction={vi.fn()} />);
    expect(screen.queryByTitle('新页面打开 WorkUnit 详情')).not.toBeInTheDocument();
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

  it('点选选项 → onInlineReply(message, value) 走现有内嵌回复通道', () => {
    const onInlineReply = vi.fn();
    const msg = optionsMessage({ options: OPTIONS });
    render(<ChannelMessageItem message={msg} onAction={vi.fn()} waitingForInput onInlineReply={onInlineReply} />);
    fireEvent.click(screen.getByText('studio-config'));
    expect(onInlineReply).toHaveBeenCalledWith(msg, '/root/projects/studio-config');
  });

  it('发送后选项卡收起为已回复提示', () => {
    render(<ChannelMessageItem message={optionsMessage({ options: OPTIONS })} onAction={vi.fn()} waitingForInput onInlineReply={vi.fn()} />);
    fireEvent.click(screen.getByText('studio'));
    expect(screen.getByText(/已回复/)).toBeTruthy();
    expect(screen.queryByText('studio-config')).toBeNull();
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
    const link = screen.getByTitle(`打开 WorkUnit 详情：${uuid}`);
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
