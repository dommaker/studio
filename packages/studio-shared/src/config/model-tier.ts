// Model Tier → 模型名映射（2026-05-08）
// RoleConfig 中写逻辑层级(fast/standard/premium)，运行时按 env 解析模型名

export type ModelTier = 'fast' | 'standard' | 'premium';

const DEFAULT_MODEL_MAP: Record<ModelTier, string> = {
  fast: 'deepseek-v4-flash',
  standard: 'deepseek-v4-flash',
  premium: 'deepseek-v4-pro[1m]',
};

export function getModelForTier(tier: ModelTier): string {
  // Env 覆盖 > 默认值
  const envKey = `MODEL_TIER_${tier.toUpperCase()}`;
  return process.env[envKey] || DEFAULT_MODEL_MAP[tier];
}

export function getModelTierConfig(tier: ModelTier) {
  return {
    tier,
    model: getModelForTier(tier),
  };
}
