/**
 * JoinComputeDialog tests — P7-02 Token generation dialog
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JoinComputeDialog } from '../JoinComputeDialog';

vi.mock('../../api', () => ({
  workspaceTokenApi: {
    generate: vi.fn(),
  },
}));

import { workspaceTokenApi } from '../../api';

describe('JoinComputeDialog', () => {
  const mockOnClose = vi.fn();
  const mockOnGenerated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dialog with name input', () => {
    render(<JoinComputeDialog open={true} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });

  it('shows generate button', () => {
    render(<JoinComputeDialog open={true} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument();
  });

  it('generates token and shows command', async () => {
    vi.mocked(workspaceTokenApi.generate).mockResolvedValue({
      data: { data: { id: 'tok-1', name: 'my-pc', token: 'ws_abc123' } },
    });

    render(<JoinComputeDialog open={true} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'my-pc' } });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByText(/studio daemon start/)).toBeInTheDocument();
    });
    expect(screen.getByText(/ws_abc123/)).toBeInTheDocument();
  });

  it('calls onGenerated after successful generation', async () => {
    vi.mocked(workspaceTokenApi.generate).mockResolvedValue({
      data: { data: { id: 'tok-1', name: 'my-pc', token: 'ws_abc123' } },
    });

    render(<JoinComputeDialog open={true} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'my-pc' } });
    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => {
      expect(mockOnGenerated).toHaveBeenCalledWith('tok-1');
    });
  });

  it('calls onClose when cancel clicked', () => {
    render(<JoinComputeDialog open={true} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('does not render when open is false', () => {
    render(<JoinComputeDialog open={false} onClose={mockOnClose} onGenerated={mockOnGenerated} />);
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });
});
