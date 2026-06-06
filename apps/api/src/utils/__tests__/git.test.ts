import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDefaultBranch } from '../git.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';

describe('getDefaultBranch', () => {
  const mockExec = vi.mocked(execSync);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns remote HEAD branch when available', () => {
    mockExec.mockReturnValue('  refs/remotes/origin/main\n');
    expect(getDefaultBranch('/repo')).toBe('main');
  });

  it('falls back to local main when remote HEAD unavailable', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('symbolic-ref')) throw new Error('no remote');
      if (cmd.includes('rev-parse --verify main')) return '';
      throw new Error('not found');
    });
    expect(getDefaultBranch('/repo')).toBe('main');
  });

  it('falls back to local master when main unavailable', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('symbolic-ref')) throw new Error('no remote');
      if (cmd.includes('rev-parse --verify main')) throw new Error('no main');
      if (cmd.includes('rev-parse --verify master')) return '';
      throw new Error('not found');
    });
    expect(getDefaultBranch('/repo')).toBe('master');
  });

  it('defaults to master when nothing found', () => {
    mockExec.mockImplementation(() => { throw new Error('not found'); });
    expect(getDefaultBranch('/repo')).toBe('master');
  });
});
