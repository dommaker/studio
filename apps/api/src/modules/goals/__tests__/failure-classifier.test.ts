/**
 * Behavioral tests for failure classification
 *
 * AC:
 * - Known retryable patterns (code bugs, env issues) → 'retryable'
 * - Known non-retryable patterns (approach infeasibility) → 'not-retryable'
 * - Unknown patterns → 'unknown'
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { classifyFailure } from '../failure-classifier.js';

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

  // Unknown
  test('classifies unrecognized error as unknown', () => {
    expect(classifyFailure('Something weird happened')).toBe('unknown');
  });

  test('classifies empty error as unknown', () => {
    expect(classifyFailure('')).toBe('unknown');
  });
});
