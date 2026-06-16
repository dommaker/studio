/**
 * CLI Spawn 环境变量构造
 *
 * R4: 统一 Claude CLI 子进程的 ANTHROPIC_* 环境变量构造。
 * 消除各 Agent 中重复的 env 拼接。
 *
 * 角色映射：
 *   analyst → STUDIO_* key
 *   executor / reviewer / default → PIPELINE_* key（fallback STUDIO_*）
 *
 * 模型：显式设置 ANTHROPIC_MODEL，防止进程环境中的值覆盖。
 * getModelForTier 返回的模型名与 ANTHROPIC_BASE_URL 端点匹配。
 */

import { getModelForTier, type ModelTier } from '../config/model-tier.js';

export interface SpawnEnvOptions {
  tier?: string;
  role?: 'analyst' | 'executor' | 'reviewer';
  extra?: Record<string, string>;
}

export function buildSpawnEnv(options: SpawnEnvOptions = {}): Record<string, string> {
  const { tier, role = 'executor', extra } = options;

  const isAnalyst = role === 'analyst';
  const apiKey = isAnalyst
    ? (process.env.STUDIO_API_KEY || '')
    : (process.env.PIPELINE_API_KEY || process.env.STUDIO_API_KEY || '');
  // Claude CLI 需要 Anthropic 兼容端点（/anthropic/v1/messages），
  // 而非 OpenAI 兼容端点（/v1/chat/completions）。
  // 自动将 /v1 后缀替换为 /anthropic。
  const rawBaseUrl = isAnalyst
    ? (process.env.STUDIO_BASE_URL || '')
    : (process.env.PIPELINE_BASE_URL || process.env.STUDIO_BASE_URL || '');
  const baseUrl = rawBaseUrl.replace(/\/v1$/, '/anthropic');

  const env: Record<string, string> = { ...extra };
  // 只在显式配置了 key 时覆盖，避免空字符串覆盖 process.env 中的有效值
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  // 显式设置 ANTHROPIC_MODEL，防止进程环境中的值（如 mimo-v2.5-pro）覆盖
  // getModelForTier 返回与 ANTHROPIC_BASE_URL 端点匹配的模型名
  const validTier = tier && ['fast', 'standard', 'premium'].includes(tier) ? tier as ModelTier : 'standard';
  env.ANTHROPIC_MODEL = getModelForTier(validTier);

  // premium tier → 最大推理努力
  if (validTier === 'premium') {
    env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  }

  // DB 隔离：Agent 进程不可写生产数据库。
  // 空字符串让 Prisma 立即报错，阻止 migrate dev / db push 等破坏性操作。
  // Migration 应用由 server 在 integration merge 后统一执行。
  env.DATABASE_URL = '';

  return env;
}
