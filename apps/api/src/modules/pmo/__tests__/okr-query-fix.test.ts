/**
 * OKR query fixes — source-code analysis tests
 *
 * 1. queryRollbackRate returns 0 (no deploy rollback mechanism)
 * 2. rollback_rate METRIC_REGISTRY description mentions N/A
 * 3. queryPipelineGoalCost references costUsd
 * 4. queryPipelineGoalCost has token fallback
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_PATH = path.resolve(__dirname, '../okr.service.ts');
const source = fs.readFileSync(SERVICE_PATH, 'utf-8');

describe('queryRollbackRate fix', () => {
  it('returns 0 — system has no deploy rollback mechanism', () => {
    // Extract the queryRollbackRate method body
    const methodMatch = source.match(
      /private\s+async\s+queryRollbackRate[\s\S]*?\n\s*\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // Must return 0 directly, not query deploy events for success===false
    expect(body).toContain('return 0');
    expect(body).not.toContain('deploy.completed');
    expect(body).not.toContain('success === false');
  });

  it('METRIC_REGISTRY description mentions N/A', () => {
    const registryMatch = source.match(
      /rollback_rate:\s*\{[\s\S]*?description:\s*'([^']*)'/,
    );
    expect(registryMatch).toBeTruthy();
    const description = registryMatch![1];
    expect(description).toMatch(/N\/A/);
  });
});

describe('queryPipelineGoalCost fix', () => {
  it('references costUsd from StudioEvent', () => {
    const methodMatch = source.match(
      /private\s+async\s+queryPipelineGoalCost[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    expect(body).toContain('costUsd');
    expect(body).toContain('execution_run');
  });

  it('has token-based fallback when costUsd unavailable', () => {
    const methodMatch = source.match(
      /private\s+async\s+queryPipelineGoalCost[\s\S]*?\n\s{2}\}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // Must still reference token fields as fallback
    expect(body).toContain('inputTokens');
    expect(body).toContain('outputTokens');
    // Must have fallback logic (two separate queries)
    expect(body).toMatch(/[Ff]allback/);
  });
});
