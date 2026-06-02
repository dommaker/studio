/**
 * ConversationMessageList tests — P1-06 Conversation UI
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConversationMessageList } from '../ConversationMessageList';

const mockMessages = [
  { id: 'msg-1', role: 'user', content: '帮我写一个函数', createdAt: '2026-06-02T10:00:00Z' },
  { id: 'msg-2', role: 'assistant', content: '好的，这是函数...', createdAt: '2026-06-02T10:00:05Z' },
  { id: 'msg-3', role: 'assistant', content: null, createdAt: '2026-06-02T10:00:10Z', thinking: true },
];

describe('ConversationMessageList', () => {
  it('renders messages', () => {
    render(<ConversationMessageList messages={mockMessages.slice(0, 2)} />);
    expect(screen.getByText('帮我写一个函数')).toBeInTheDocument();
    expect(screen.getByText('好的，这是函数...')).toBeInTheDocument();
  });

  it('shows user and assistant roles', () => {
    render(<ConversationMessageList messages={mockMessages.slice(0, 2)} />);
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('assistant')).toBeInTheDocument();
  });

  it('shows thinking indicator', () => {
    render(<ConversationMessageList messages={mockMessages} />);
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });

  it('shows empty state when no messages', () => {
    render(<ConversationMessageList messages={[]} />);
    expect(screen.getByText(/no messages/i)).toBeInTheDocument();
  });
});
