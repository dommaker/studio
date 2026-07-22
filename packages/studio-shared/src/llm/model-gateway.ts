/**
 * Model Gateway - Facade
 *
 * @deprecated use systemExecutor (apps/api/src/modules/agents/system-executor.ts) for system-level LLM calls.
 * modelGateway 保留至 Phase 4 删除前，仅供未迁移的消费方使用。新代码禁止使用。
 *
 * 统一 LLM 调用网关：多 provider 管理、优先级路由、自动 fallback、token 用量统计
 *
 * P11-06: Split into sub-modules:
 *   provider-registry.ts — LLM provider 注册/查询
 *   model-router.ts — 类型定义 + 模型选择/路由逻辑 + 统一调用入口 + prompt 缓存
 *   usage-tracker.ts — token/cost 用量统计
 */

// Re-export all types from model-router (canonical source)
export type {
  ProviderConfig,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  UsageRecord,
  GatewayStats,
} from './model-router.js';

// Re-export provider-registry functions
export {
  addProvider,
  loadFromEnv,
  getProviders,
  isAvailable,
  resolveProviders,
} from './provider-registry.js';

// Re-export model-router functions and classes
export {
  PromptCache,
  chat,
  prompt,
  promptJson,
  extractJson,
} from './model-router.js';

// Re-export usage-tracker functions
export {
  recordUsage,
  getStats,
  getRecentUsage,
  scoreQuality,
} from './usage-tracker.js';

// ─── ModelGateway class (thin facade over sub-modules) ───

import type { ProviderConfig, GatewayRequest, GatewayResponse, UsageRecord, GatewayStats } from './model-router.js';
import { addProvider as addProviderFn, loadFromEnv as loadFromEnvFn, getProviders as getProvidersFn, isAvailable as isAvailableFn } from './provider-registry.js';
import { PromptCache, chat as chatFn, prompt as promptFn, promptJson as promptJsonFn } from './model-router.js';
import { getStats as getStatsFn, getRecentUsage as getRecentUsageFn } from './usage-tracker.js';

export class ModelGateway {
  private providers: ProviderConfig[] = [];
  private usageLog: UsageRecord[] = [];
  private promptCache = new PromptCache();

  addProvider(config: ProviderConfig): void {
    addProviderFn(this.providers, config);
  }

  loadFromEnv(): void {
    loadFromEnvFn((config) => this.addProvider(config));
  }

  async chat(request: GatewayRequest): Promise<GatewayResponse> {
    return chatFn(request, this.providers, { log: this.usageLog }, this.promptCache);
  }

  async prompt(text: string, systemPrompt?: string, options?: Partial<GatewayRequest>): Promise<string> {
    return promptFn(text, systemPrompt, (req) => this.chat(req), options);
  }

  async promptJson<T = any>(text: string, systemPrompt?: string, options?: Partial<GatewayRequest>): Promise<T> {
    return promptJsonFn<T>(text, systemPrompt, (req) => this.chat(req), options);
  }

  getProviders(): Array<{ name: string; model: string; priority: number; enabled: boolean }> {
    return getProvidersFn(this.providers);
  }

  getStats(): GatewayStats {
    return getStatsFn(this.usageLog);
  }

  getRecentUsage(n = 50): UsageRecord[] {
    return getRecentUsageFn(this.usageLog, n);
  }

  isAvailable(): boolean {
    return isAvailableFn(this.providers);
  }
}

// 单例
export const modelGateway = new ModelGateway();
