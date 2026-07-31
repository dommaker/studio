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
vi.mock('../channel/DeployApprovalCard', () => ({ DeployApprovalCard: () => null }));
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
