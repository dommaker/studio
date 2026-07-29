/**
 * Model Gateway - Facade
 *
 * 统一 LLM 调用网关：多 provider 管理、优先级路由、自动 fallback、token 用量统计
 *
 * P11-06: Split into sub-modules:
 *   provider-registry.ts — LLM provider 注册/查询
 *   model-router.ts — 类型定义 + 模型选择/路由逻辑 + 统一调用入口 + prompt 缓存
 *   usage-tracker.ts — token/cost 用量统计
 */
export type { ProviderConfig, GatewayMessage, GatewayRequest, GatewayResponse, UsageRecord, GatewayStats, } from './model-router.js';
export { addProvider, loadFromEnv, getProviders, isAvailable, resolveProviders, } from './provider-registry.js';
export { PromptCache, chat, prompt, promptJson, extractJson, } from './model-router.js';
export { recordUsage, getStats, getRecentUsage, scoreQuality, } from './usage-tracker.js';
import type { ProviderConfig, GatewayRequest, GatewayResponse, UsageRecord, GatewayStats } from './model-router.js';
export declare class ModelGateway {
    private providers;
    private usageLog;
    private promptCache;
    addProvider(config: ProviderConfig): void;
    loadFromEnv(): void;
    chat(request: GatewayRequest): Promise<GatewayResponse>;
    prompt(text: string, systemPrompt?: string, options?: Partial<GatewayRequest>): Promise<string>;
    promptJson<T = any>(text: string, systemPrompt?: string, options?: Partial<GatewayRequest>): Promise<T>;
    getProviders(): Array<{
        name: string;
        model: string;
        priority: number;
        enabled: boolean;
    }>;
    getStats(): GatewayStats;
    getRecentUsage(n?: number): UsageRecord[];
    isAvailable(): boolean;
}
export declare const modelGateway: ModelGateway;
//# sourceMappingURL=model-gateway.d.ts.map