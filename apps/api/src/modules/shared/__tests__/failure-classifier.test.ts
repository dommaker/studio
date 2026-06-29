/**
 * Behavioral tests for failure classification
 *
 * AC:
 * - Known retryable patterns (code bugs, env issues) → 'retryable'
 * - Known non-retryable patterns (approach infeasibility) → 'not-retryable'
 * - Infrastructure patterns (worktree/DB/service) → 'infrastructure'
 * - Unknown patterns → 'unknown'
 * - classifyFailureAction maps failure class → deterministic action
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { classifyFailure, classifyFailureAction } from '../failure-classifier.js';

describe('classifyFailure()', () => {
  // Retryable: code bugs
  test('classifies TypeError as retryable', () => {
    expect(classifyFailure("TypeError: Cannot read properties of undefined")).toBe('retryable');
  });

  test('classifies SyntaxError as retryable', () => {
    expect(classifyFailure("SyntaxError: Unexpected token '}'")).toBe('retryable');
  });

  test('classifies ReferenceError as retryable', () => {
    expect(classifyFailure('ReferenceError: foo is not defined')).toBe('retryable');
  });

  // Retryable: env issues
  test('classifies ENOENT as retryable', () => {
    expect(classifyFailure("ENOENT: no such file or directory, open '/tmp/foo'")).toBe('retryable');
  });

  test('classifies EACCES as retryable', () => {
    expect(classifyFailure('EACCES: permission denied')).toBe('retryable');
  });

  test('classifies module not found as retryable', () => {
    expect(classifyFailure("Cannot find module '@dommaker/studio-shared'")).toBe('retryable');
  });

  // Retryable: test/build failures
  test('classifies test failure as retryable', () => {
    expect(classifyFailure('Tests failed: 2 passed, 1 failed')).toBe('retryable');
  });

  test('classifies build error as retryable', () => {
    expect(classifyFailure('Build failed with exit code 1')).toBe('retryable');
  });

  // Not retryable: approach issues
  test('classifies approach infeasible as not-retryable', () => {
    expect(classifyFailure('The approach is infeasible because the API does not support this')).toBe('not-retryable');
  });

  test('classifies API does not exist as not-retryable', () => {
    expect(classifyFailure('Error: API endpoint does not exist')).toBe('not-retryable');
  });

  test('classifies not supported as not-retryable', () => {
    expect(classifyFailure('This feature is not supported in the current version')).toBe('not-retryable');
  });

  // Infrastructure
  test('classifies Worktree lost as infrastructure', () => {
    expect(classifyFailure('Worktree lost after service restart')).toBe('infrastructure');
  });

  test('classifies worktree ENOENT as infrastructure', () => {
    expect(classifyFailure('worktree directory ENOENT: /root/worktrees/abc123')).toBe('infrastructure');
  });

  test('classifies DB connection as infrastructure', () => {
    expect(classifyFailure('DB connection lost: ECONNREFUSED 127.0.0.1:5432')).toBe('infrastructure');
  });

  test('classifies service restart as infrastructure', () => {
    expect(classifyFailure('Execution failed after service restart')).toBe('infrastructure');
  });

  // Unknown
  test('classifies unrecognized error as unknown', () => {
    expect(classifyFailure('Something weird happened')).toBe('unknown');
  });

  test('classifies empty error as unknown', () => {
    expect(classifyFailure('')).toBe('unknown');
  });
});

describe('classifyFailureAction()', () => {
  // Infrastructure → retry-execution
  test('Worktree lost → retry-execution / infrastructure', () => {
    const result = classifyFailureAction('Worktree lost after service restart');
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'infrastructure' });
  });

  test('worktree ENOENT → retry-execution / infrastructure', () => {
    const result = classifyFailureAction('worktree directory ENOENT');
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'infrastructure' });
  });

  test('DB connection → retry-execution / infrastructure', () => {
    const result = classifyFailureAction('DB connection lost');
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'infrastructure' });
  });

  test('service restart → retry-execution / infrastructure', () => {
    const result = classifyFailureAction('Execution failed after service restart');
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'infrastructure' });
  });

  // Retryable → retry-execution
  test('TypeError → retry-execution / retryable', () => {
    const result = classifyFailureAction('TypeError: Cannot read properties of undefined');
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'retryable' });
  });

  test('ENOENT (non-worktree) → retry-execution / retryable', () => {
    const result = classifyFailureAction("ENOENT: no such file or directory, open '/tmp/foo'");
    expect(result).toEqual({ action: 'retry-execution', failureClass: 'retryable' });
  });

  // Not-retryable → mark-blocked
  test('approach infeasible → mark-blocked / not-retryable', () => {
    const result = classifyFailureAction('The approach is infeasible');
    expect(result).toEqual({ action: 'mark-blocked', failureClass: 'not-retryable' });
  });

  // Unknown → triage-agent
  test('unrecognized → triage-agent / unknown', () => {
    const result = classifyFailureAction('Something weird happened');
    expect(result).toEqual({ action: 'triage-agent', failureClass: 'unknown' });
  });

  test('empty → triage-agent / unknown', () => {
    const result = classifyFailureAction('');
    expect(result).toEqual({ action: 'triage-agent', failureClass: 'unknown' });
  });
});
