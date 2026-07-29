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
// Re-export provider-registry functions
export { addProvider, loadFromEnv, getProviders, isAvailable, resolveProviders, } from './provider-registry.js';
// Re-export model-router functions and classes
export { PromptCache, chat, prompt, promptJson, extractJson, } from './model-router.js';
// Re-export usage-tracker functions
export { recordUsage, getStats, getRecentUsage, scoreQuality, } from './usage-tracker.js';
import { addProvider as addProviderFn, loadFromEnv as loadFromEnvFn, getProviders as getProvidersFn, isAvailable as isAvailableFn } from './provider-registry.js';
import { PromptCache, chat as chatFn, prompt as promptFn, promptJson as promptJsonFn } from './model-router.js';
import { getStats as getStatsFn, getRecentUsage as getRecentUsageFn } from './usage-tracker.js';
export class ModelGateway {
    providers = [];
    usageLog = [];
    promptCache = new PromptCache();
    addProvider(config) {
        addProviderFn(this.providers, config);
    }
    loadFromEnv() {
        loadFromEnvFn((config) => this.addProvider(config));
    }
    async chat(request) {
        return chatFn(request, this.providers, { log: this.usageLog }, this.promptCache);
    }
    async prompt(text, systemPrompt, options) {
        return promptFn(text, systemPrompt, (req) => this.chat(req), options);
    }
    async promptJson(text, systemPrompt, options) {
        return promptJsonFn(text, systemPrompt, (req) => this.chat(req), options);
    }
    getProviders() {
        return getProvidersFn(this.providers);
    }
    getStats() {
        return getStatsFn(this.usageLog);
    }
    getRecentUsage(n = 50) {
        return getRecentUsageFn(this.usageLog, n);
    }
    isAvailable() {
        return isAvailableFn(this.providers);
    }
}
// 单例
export const modelGateway = new ModelGateway();
//# sourceMappingURL=model-gateway.js.map