// Model Tier — 任务规格标签（fast/standard/premium）
//
// 2026-07-28 起不再承担 "tier → 模型名" 映射（原 getModelForTier 已删除）：
// 模型选择归算力提供方——角色绑定的 CLI 用自身配置决定模型，Studio spawn
// 一律不传 model。该类型仅作为任务规格/超时档位标签保留
// （见 studio-agent runner-params 的 TIER_TIMEOUTS / TIER_MAX_TURNS）。

export type ModelTier = 'fast' | 'standard' | 'premium';
