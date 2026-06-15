/**
 * spawn-claude-cli — buildSpawnEnv tests
 *
 * R4: CLI spawn encapsulation
 * - buildSpawnEnv 根据 role 选择 PIPELINE_* 或 STUDIO_* key
 * - tier 通过 getModelForTier 解析为 model name
 * - 可附加额外 env（STUDIO_EXECUTION_ID 等）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSpawnEnv } from '../spawn-claude-cli.js';

describe('buildSpawnEnv', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env.PIPELINE_API_KEY = 'pipeline-key';
    process.env.PIPELINE_BASE_URL = 'https://pipeline.example.com';
    process.env.STUDIO_API_KEY = 'studio-key';
    process.env.STUDIO_BASE_URL = 'https://studio.example.com';
    process.env.MODEL_TIER_FAST = 'fast-model';
    process.env.MODEL_TIER_STANDARD = 'standard-model';
    process.env.MODEL_TIER_PREMIUM = 'premium-model';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('executor role → uses PIPELINE_* keys', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_API_KEY).toBe('pipeline-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://pipeline.example.com');
    expect(env.ANTHROPIC_MODEL).toBe('standard-model');
  });

  it('base URL /v1 → /anthropic for Claude CLI', () => {
    process.env.PIPELINE_BASE_URL = 'https://api.deepseek.com/v1';
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
  });

  it('base URL without /v1 → unchanged', () => {
    process.env.PIPELINE_BASE_URL = 'https://custom.example.com';
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
  });

  it('analyst role → uses STUDIO_* keys', () => {
    const env = buildSpawnEnv({ tier: 'premium', role: 'analyst' });
    expect(env.ANTHROPIC_API_KEY).toBe('studio-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://studio.example.com');
    expect(env.ANTHROPIC_MODEL).toBe('premium-model');
  });

  it('reviewer role → uses PIPELINE_* keys', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'reviewer' });
    expect(env.ANTHROPIC_API_KEY).toBe('pipeline-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://pipeline.example.com');
  });

  it('default role (no role) → uses PIPELINE_* keys', () => {
    const env = buildSpawnEnv({ tier: 'fast' });
    expect(env.ANTHROPIC_API_KEY).toBe('pipeline-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://pipeline.example.com');
    expect(env.ANTHROPIC_MODEL).toBe('fast-model');
  });

  it('merges extra env vars', () => {
    const env = buildSpawnEnv({
      tier: 'standard',
      role: 'executor',
      extra: { STUDIO_EXECUTION_ID: 'exec-123', STUDIO_GOAL_ID: 'goal-456' },
    });
    expect(env.STUDIO_EXECUTION_ID).toBe('exec-123');
    expect(env.STUDIO_GOAL_ID).toBe('goal-456');
    expect(env.ANTHROPIC_API_KEY).toBe('pipeline-key');
  });

  it('unknown tier → model from getModelForTier (may be undefined)', () => {
    const env = buildSpawnEnv({ tier: 'unknown' });
    // getModelForTier returns undefined for unknown tier; Claude CLI uses its own default
    expect(env.ANTHROPIC_API_KEY).toBe('pipeline-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://pipeline.example.com');
  });

  it('PIPELINE_API_KEY not set → falls back to STUDIO_API_KEY', () => {
    delete process.env.PIPELINE_API_KEY;
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_API_KEY).toBe('studio-key');
  });

  it('premium tier → CLAUDE_CODE_EFFORT_LEVEL=max', () => {
    const env = buildSpawnEnv({ tier: 'premium', role: 'executor' });
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('standard tier → no CLAUDE_CODE_EFFORT_LEVEL', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('fast tier → no CLAUDE_CODE_EFFORT_LEVEL', () => {
    const env = buildSpawnEnv({ tier: 'fast', role: 'executor' });
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });
});
