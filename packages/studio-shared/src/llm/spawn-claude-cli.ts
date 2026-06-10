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
 * 模型：不设置 ANTHROPIC_MODEL，CLI 继承 process.env 中已配置的值。
 * （getModelForTier 返回 deepseek 模型名，与 Claude CLI 不兼容）
 */

export interface SpawnEnvOptions {
  tier?: string;
  role?: 'analyst' | 'executor' | 'reviewer';
  extra?: Record<string, string>;
}

export function buildSpawnEnv(options: SpawnEnvOptions = {}): Record<string, string> {
  const { role = 'executor', extra } = options;

  const isAnalyst = role === 'analyst';
  const apiKey = isAnalyst
    ? (process.env.STUDIO_API_KEY || '')
    : (process.env.PIPELINE_API_KEY || process.env.STUDIO_API_KEY || '');
  const baseUrl = isAnalyst
    ? (process.env.STUDIO_BASE_URL || '')
    : (process.env.PIPELINE_BASE_URL || process.env.STUDIO_BASE_URL || '');

  const env: Record<string, string> = { ...extra };
  // 只在显式配置了 key 时覆盖，避免空字符串覆盖 process.env 中的有效值
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  return env;
}
