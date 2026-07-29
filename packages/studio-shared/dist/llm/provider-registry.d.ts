/**
 * Provider Registry — LLM provider 注册/查询
 *
 * Gateway 只注册 studio provider。Pipeline/Knowledge 走 CLI spawn / direct fetch。
 */
import type { ProviderConfig, GatewayRequest } from './model-router.js';
/**
 * 注册 provider
 */
export declare function addProvider(providers: ProviderConfig[], config: ProviderConfig): void;
/**
 * 从环境变量自动注册 gateway provider
 *
 * config.env 格式：
 *   STUDIO_BASE_URL=...    STUDIO_API_KEY=...
 *   MODEL_TIER_FAST=...    MODEL_TIER_STANDARD=...    MODEL_TIER_PREMIUM=...
 */
export declare function loadFromEnv(addFn: (config: ProviderConfig) => void): void;
/**
 * 获取可用 providers 列表
 */
export declare function getProviders(providers: ProviderConfig[]): Array<{
    name: string;
    model: string;
    priority: number;
    enabled: boolean;
}>;
/**
 * 是否有可用 provider
 */
export declare function isAvailable(providers: ProviderConfig[]): boolean;
/**
 * 根据请求解析可用 providers（角色过滤 + 指定 provider + tier model 解析）
 */
export declare function resolveProviders(providers: ProviderConfig[], request: GatewayRequest): ProviderConfig[];
//# sourceMappingURL=provider-registry.d.ts.map