/**
 * Behavioral test: execSh error message includes stderr or falls back to stdout.
 *
 * AC:
 *   1. Error message includes stderr when present
 *   2. Error message falls back to stdout when stderr is empty
 */
import { describe, test, expect } from 'vitest';
import { execSh } from '../process-io';

const baseOpts = { cwd: '/tmp', timeoutMs: 10_000 };

describe('execSh error message aggregation', () => {
  test('includes stderr when present', async () => {
    await expect(
      execSh('echo "real error" >&2; exit 1', baseOpts),
    ).rejects.toThrow(/real error/);
  });

  test('falls back to stdout when stderr is empty', async () => {
    await expect(
      execSh('echo "stdout-only-error"; exit 1', baseOpts),
    ).rejects.toThrow(/stdout-only-error/);
  });

  test('prefers stderr over stdout when both present', async () => {
    await expect(
      execSh('echo "stderr-msg" >&2; echo "stdout-msg"; exit 1', baseOpts),
    ).rejects.toThrow(/stderr-msg/);
  });
});
