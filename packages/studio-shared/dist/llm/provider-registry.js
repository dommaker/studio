/**
 * Provider Registry — LLM provider 注册/查询
 *
 * Gateway 只注册 studio provider。Pipeline/Knowledge 走 CLI spawn / direct fetch。
 */
import { logger } from '../utils/logger.js';
/**
 * 注册 provider
 */
export function addProvider(providers, config) {
    providers.push({ ...config, enabled: config.enabled ?? true });
    providers.sort((a, b) => a.priority - b.priority);
    logger.info(`[Gateway] Provider registered: ${config.name} (${config.model})`);
}
/**
 * 从环境变量自动注册 gateway provider
 *
 * config.env 格式：
 *   STUDIO_BASE_URL=...    STUDIO_API_KEY=...
 *   MODEL_TIER_FAST=...    MODEL_TIER_STANDARD=...    MODEL_TIER_PREMIUM=...
 */
export function loadFromEnv(addFn) {
    const baseUrl = process.env.STUDIO_BASE_URL;
    const apiKey = process.env.STUDIO_API_KEY;
    const defaultModel = process.env.MODEL_TIER_FAST || 'deepseek-v4-flash';
    if (baseUrl && apiKey) {
        const tierModels = {};
        if (process.env.MODEL_TIER_FAST)
            tierModels['fast'] = process.env.MODEL_TIER_FAST;
        if (process.env.MODEL_TIER_STANDARD)
            tierModels['standard'] = process.env.MODEL_TIER_STANDARD;
        if (process.env.MODEL_TIER_PREMIUM)
            tierModels['premium'] = process.env.MODEL_TIER_PREMIUM;
        addFn({
            name: 'studio',
            baseUrl,
            apiKey,
            model: defaultModel,
            priority: 0,
            ...(Object.keys(tierModels).length > 0 ? { tierModels } : {}),
        });
    }
}
/**
 * 获取可用 providers 列表
 */
export function getProviders(providers) {
    return providers.map(p => ({
        name: p.name,
        model: p.model,
        priority: p.priority,
        enabled: p.enabled ?? true,
    }));
}
/**
 * 是否有可用 provider
 */
export function isAvailable(providers) {
    return providers.some(p => p.enabled !== false && !!p.apiKey);
}
/**
 * 根据请求解析可用 providers（角色过滤 + 指定 provider + tier model 解析）
 */
export function resolveProviders(providers, request) {
    let filtered = providers.filter(p => p.enabled !== false && !!p.apiKey);
    // 角色权限过滤
    if (request.role) {
        filtered = filtered.filter(p => !p.allowedRoles || p.allowedRoles.length === 0 || p.allowedRoles.includes(request.role));
    }
    // 指定 provider
    if (request.provider) {
        const named = filtered.filter(p => p.name === request.provider);
        if (named.length > 0)
            filtered = named;
        else
            logger.warn(`[Gateway] Requested provider "${request.provider}" not found, using default routing`);
    }
    // Tier model 解析：request.tier + provider.tierModels → 替换 provider.model
    if (request.tier) {
        filtered = filtered.map(p => {
            const tierModel = p.tierModels?.[request.tier];
            if (tierModel) {
                return { ...p, model: tierModel };
            }
            return p;
        });
    }
    return filtered;
}
//# sourceMappingURL=provider-registry.js.map