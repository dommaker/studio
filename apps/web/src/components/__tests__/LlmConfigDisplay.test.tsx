/**
 * LlmConfigDisplay tests — P9-03 LLM config env var display
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { LlmConfigDisplay } from '../LlmConfigDisplay';

vi.mock('../../api', () => ({
  llmConfigApi: {
    list: vi.fn(),
    test: vi.fn(),
  },
}));

import { llmConfigApi } from '../../api';

const mockConfigs = [
  { id: 'cfg-1', scope: 'conversation', provider: 'openai', model: 'gpt-4', hasKey: true },
  { id: 'cfg-2', scope: 'pipeline', provider: 'hunyuan', model: 'hunyuan-pro', hasKey: false },
];

describe('LlmConfigDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (llmConfigApi.list as any).mockResolvedValue({ data: { data: mockConfigs } });
  });

  it('renders config list', async () => {
    render(<LlmConfigDisplay />);
    expect(await screen.findByText('conversation')).toBeInTheDocument();
    expect(screen.getByText('pipeline')).toBeInTheDocument();
  });

  it('shows provider and model', async () => {
    render(<LlmConfigDisplay />);
    await screen.findByText('conversation');
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('gpt-4')).toBeInTheDocument();
  });

  it('shows masked status for configured keys', async () => {
    render(<LlmConfigDisplay />);
    await screen.findByText('conversation');
    expect(screen.getByText('Configured')).toBeInTheDocument();
  });

  it('shows not configured when no key', async () => {
    render(<LlmConfigDisplay />);
    await screen.findByText('pipeline');
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    (llmConfigApi.list as any).mockResolvedValue({ data: { data: [] } });
    render(<LlmConfigDisplay />);
    expect(await screen.findByText(/no configs/i)).toBeInTheDocument();
  });
});
