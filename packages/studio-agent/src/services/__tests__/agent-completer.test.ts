/**
 * Agent Completer tests — complete(), detectOutputFiles(), cleanupWorktree()
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  eventBus: { publish: vi.fn() },
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid-0000',
}));

import { AgentCompleter } from '../agent-completer.js';

describe('AgentCompleter', () => {
  let completer: AgentCompleter;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completer-test-'));
    completer = new AgentCompleter(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('detectOutputFiles', () => {
    it('returns empty for empty directory', async () => {
      const worktree = path.join(tmpDir, 'empty');
      await fs.mkdir(worktree);
      const files = await completer.detectOutputFiles(worktree);
      expect(files).toEqual([]);
    });

    it('detects markdown, json, and text files', async () => {
      const worktree = path.join(tmpDir, 'has-files');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'report.md'), '# Report');
      await fs.writeFile(path.join(worktree, 'data.json'), '{}');
      await fs.writeFile(path.join(worktree, 'notes.txt'), 'notes');

      const files = await completer.detectOutputFiles(worktree);
      expect(files).toHaveLength(3);

      const byName = Object.fromEntries(files.map(f => [f.name, f]));
      expect(byName['report.md'].type).toBe('markdown');
      expect(byName['data.json'].type).toBe('json');
      expect(byName['notes.txt'].type).toBe('text');
    });

    it('skips hidden files and .log files', async () => {
      const worktree = path.join(tmpDir, 'with-hidden');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, '.hidden'), 'secret');
      await fs.writeFile(path.join(worktree, 'debug.log'), 'logs');
      await fs.writeFile(path.join(worktree, 'output.md'), 'content');

      const files = await completer.detectOutputFiles(worktree);
      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('output.md');
    });

    it('returns empty for nonexistent directory', async () => {
      const files = await completer.detectOutputFiles('/nonexistent/path');
      expect(files).toEqual([]);
    });
  });

  describe('complete', () => {
    it('returns success when verify-report has passes', async () => {
      const worktree = path.join(tmpDir, 'task-success');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'verify-report.md'), '✅ Test 1 passed\n✅ Test 2 passed');

      const result = await completer.complete('task-success');

      expect(result.success).toBe(true);
      expect(result.verifyStatus).toBe('passed');
      expect(result.taskId).toBe('task-success');
    });

    it('returns partial when verify-report has mixed results', async () => {
      const worktree = path.join(tmpDir, 'task-partial');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'verify-report.md'), '✅ Passed\n❌ Failed');

      const result = await completer.complete('task-partial');

      // partial → success is true (only 'failed' and 'no_output' are false)
      expect(result.success).toBe(true);
      expect(result.verifyStatus).toBe('partial');
    });

    it('returns failed when verify-report has only failures', async () => {
      const worktree = path.join(tmpDir, 'task-fail');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'verify-report.md'), '❌ Failed\n❌ Also failed');

      const result = await completer.complete('task-fail');

      expect(result.success).toBe(false);
      expect(result.verifyStatus).toBe('failed');
    });

    it('returns passed when no verify-report but has output files', async () => {
      const worktree = path.join(tmpDir, 'task-no-report');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'output.md'), 'some output');

      const result = await completer.complete('task-no-report');

      expect(result.success).toBe(true);
      expect(result.verifyStatus).toBe('passed');
    });

    it('returns no_output when no verify-report and no files', async () => {
      const worktree = path.join(tmpDir, 'task-empty');
      await fs.mkdir(worktree);

      const result = await completer.complete('task-empty');

      expect(result.success).toBe(false);
      expect(result.verifyStatus).toBe('no_output');
    });

    it('returns no_output when worktree does not exist', async () => {
      // Don't create worktree dir → detectOutputFiles returns [], parseVerification catches
      const result = await completer.complete('nonexistent-task');

      expect(result.success).toBe(false);
      expect(result.verifyStatus).toBe('no_output');
    });
  });

  describe('cleanupWorktree', () => {
    it('removes only hidden and log files when keepOutputs=true', async () => {
      const worktree = path.join(tmpDir, 'cleanup-keep');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, '.hidden'), 'x');
      await fs.writeFile(path.join(worktree, 'debug.log'), 'x');
      await fs.writeFile(path.join(worktree, 'output.md'), 'keep');

      await completer.cleanupWorktree('cleanup-keep', true);

      const remaining = await fs.readdir(worktree);
      expect(remaining).toEqual(['output.md']);
    });

    it('removes entire directory when keepOutputs=false', async () => {
      const worktree = path.join(tmpDir, 'cleanup-all');
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, 'output.md'), 'gone');

      await completer.cleanupWorktree('cleanup-all', false);

      await expect(fs.access(worktree)).rejects.toThrow();
    });

    it('does not throw for nonexistent worktree', async () => {
      await expect(completer.cleanupWorktree('nonexistent')).resolves.toBeUndefined();
    });
  });
});
