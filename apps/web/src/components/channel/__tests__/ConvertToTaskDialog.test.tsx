// Smoke test — AC-E3: ConvertToTaskDialog renders without crashing
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConvertToTaskDialog } from '../ConvertToTaskDialog';

describe('ConvertToTaskDialog', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <ConvertToTaskDialog
        open={false}
        onClose={() => {}}
        messageId="msg-1"
        channelId="ch-1"
        messageContent="test"
        onConverted={() => {}}
      />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders dialog when open=true', () => {
    render(
      <ConvertToTaskDialog
        open={true}
        onClose={() => {}}
        messageId="msg-1"
        channelId="ch-1"
        messageContent="fix the bug"
        onConverted={() => {}}
      />
    );
    expect(screen.getByText('转为任务')).toBeTruthy();
    expect(screen.getByText('创建任务')).toBeTruthy();
  });
});
