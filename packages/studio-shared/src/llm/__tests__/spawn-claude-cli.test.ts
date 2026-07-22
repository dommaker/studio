/**
 * spawn-claude-cli - buildSpawnEnv tests
 *
 * AC-1.11: buildSpawnEnv 简化为 { ...extra }（过渡期保留，AC Group 7 删除）
 * - 不再注入 ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL/ANTHROPIC_MODEL
 * - 不再注入 DATABASE_URL 空字符串
 * - 不再读 STUDIO_API_KEY/PIPELINE_API_KEY 等全局 key
 * - 透传 extra
 * - 保留 SpawnEnvOptions 类型签名（消费方未迁移完前不破坏编译）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSpawnEnv } from '../spawn-claude-cli.js';

describe('buildSpawnEnv (AC-1.11 simplified)', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // 设置旧实现会读的 env 变量，验证简化后不再读
    process.env.PIPELINE_API_KEY = 'pipeline-key';
    process.env.PIPELINE_BASE_URL = 'https://pipeline.example.com';
    process.env.STUDIO_API_KEY = 'studio-key';
    process.env.STUDIO_BASE_URL = 'https://studio.example.com';
    process.env.MODEL_TIER_FAST = 'fast-model';
    process.env.MODEL_TIER_STANDARD = 'standard-model';
    process.env.MODEL_TIER_PREMIUM = 'premium-model';
    process.env.DATABASE_URL = 'file:/prod/data.db';
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('无参数返回空对象', () => {
    const env = buildSpawnEnv();
    expect(env).toEqual({});
  });

  it('透传 extra env vars', () => {
    const env = buildSpawnEnv({
      extra: { STUDIO_EXECUTION_ID: 'exec-123', STUDIO_GOAL_ID: 'goal-456' },
    });
    expect(env.STUDIO_EXECUTION_ID).toBe('exec-123');
    expect(env.STUDIO_GOAL_ID).toBe('goal-456');
  });

  it('不再设置 ANTHROPIC_API_KEY', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('不再设置 ANTHROPIC_BASE_URL', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('不再设置 ANTHROPIC_MODEL', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });

  it('不再设置 DATABASE_URL 空字符串（CLI 继承 process.env）', () => {
    const env = buildSpawnEnv({ tier: 'standard', role: 'executor' });
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('不再设置 CLAUDE_CODE_EFFORT_LEVEL', () => {
    const env = buildSpawnEnv({ tier: 'premium', role: 'executor' });
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('忽略 tier 参数', () => {
    const envFast = buildSpawnEnv({ tier: 'fast' });
    const envPremium = buildSpawnEnv({ tier: 'premium' });
    expect(envFast).toEqual({});
    expect(envPremium).toEqual({});
  });

  it('忽略 role 参数', () => {
    const envExecutor = buildSpawnEnv({ role: 'executor' });
    const envAnalyst = buildSpawnEnv({ role: 'analyst' });
    const envReviewer = buildSpawnEnv({ role: 'reviewer' });
    expect(envExecutor).toEqual({});
    expect(envAnalyst).toEqual({});
    expect(envReviewer).toEqual({});
  });

  it('extra 与空基础合并，不混入 env 变量', () => {
    const env = buildSpawnEnv({
      tier: 'standard',
      role: 'executor',
      extra: { CUSTOM_VAR: 'value' },
    });
    expect(env).toEqual({ CUSTOM_VAR: 'value' });
  });
});
