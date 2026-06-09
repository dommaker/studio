/**
 * CLI Spawn 环境变量构造
 *
 * R4: 统一 Claude CLI 子进程的 ANTHROPIC_* 环境变量构造。
 * 消除各 Agent 中重复的 env 拼接。
 *
 * 角色映射：
 *   analyst → STUDIO_* key
 *   executor / reviewer / default → PIPELINE_* key（fallback STUDIO_*）
 */

import { getModelForTier } from '../config/model-tier.js';
import type { ModelTier } from '../config/model-tier.js';

export interface SpawnEnvOptions {
  tier: ModelTier | string;
  role?: 'analyst' | 'executor' | 'reviewer';
  extra?: Record<string, string>;
}

export function buildSpawnEnv(options: SpawnEnvOptions): Record<string, string> {
  const { tier, role = 'executor', extra } = options;

  const isAnalyst = role === 'analyst';
  const apiKey = isAnalyst
    ? (process.env.STUDIO_API_KEY || '')
    : (process.env.PIPELINE_API_KEY || process.env.STUDIO_API_KEY || '');
  const baseUrl = isAnalyst
    ? (process.env.STUDIO_BASE_URL || '')
    : (process.env.PIPELINE_BASE_URL || process.env.STUDIO_BASE_URL || '');

  return {
    ANTHROPIC_MODEL: getModelForTier(tier as ModelTier),
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: baseUrl,
    ...extra,
  };
}
