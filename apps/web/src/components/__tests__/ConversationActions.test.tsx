/**
 * ConversationActions tests — P10-03 Conversation action buttons
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConversationActions } from '../ConversationActions';

vi.mock('../../api', () => ({
  runtimeWorkflowApi: {
    execute: vi.fn(),
  },
}));

import { runtimeWorkflowApi } from '../../api';

describe('ConversationActions', () => {
  const mockOnStartExecution = vi.fn();
  const mockOnContinueDiscussion = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders start execution button', () => {
    render(
      <ConversationActions
        channelId="ch-1"
        onStartExecution={mockOnStartExecution}
        onContinueDiscussion={mockOnContinueDiscussion}
      />,
    );
    expect(screen.getByRole('button', { name: /start execution/i })).toBeInTheDocument();
  });

  it('renders continue discussion button', () => {
    render(
      <ConversationActions
        channelId="ch-1"
        onStartExecution={mockOnStartExecution}
        onContinueDiscussion={mockOnContinueDiscussion}
      />,
    );
    expect(screen.getByRole('button', { name: /continue discussion/i })).toBeInTheDocument();
  });

  it('calls onStartExecution when clicked', () => {
    render(
      <ConversationActions
        channelId="ch-1"
        onStartExecution={mockOnStartExecution}
        onContinueDiscussion={mockOnContinueDiscussion}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /start execution/i }));
    expect(mockOnStartExecution).toHaveBeenCalled();
  });

  it('calls onContinueDiscussion when clicked', () => {
    render(
      <ConversationActions
        channelId="ch-1"
        onStartExecution={mockOnStartExecution}
        onContinueDiscussion={mockOnContinueDiscussion}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /continue discussion/i }));
    expect(mockOnContinueDiscussion).toHaveBeenCalled();
  });
});
