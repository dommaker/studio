export type ModelTier = 'fast' | 'standard' | 'premium';
export declare function getModelForTier(tier: ModelTier): string;
export declare function getModelTierConfig(tier: ModelTier): {
    tier: ModelTier;
    model: string;
};
//# sourceMappingURL=model-tier.d.ts.map