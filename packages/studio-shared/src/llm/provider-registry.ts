/**
 * Provider Registry — LLM provider 注册/查询
 *
 * P11-06: Extracted from model-gateway.ts
 */

import { logger } from '../utils/logger.js';
import type { ProviderConfig, GatewayRequest } from './model-router.js';

/**
 * 注册 provider
 */
export function addProvider(providers: ProviderConfig[], config: ProviderConfig): void {
  providers.push({ ...config, enabled: config.enabled ?? true });
  providers.sort((a, b) => a.priority - b.priority);
  logger.info(`[Gateway] Provider registered: ${config.name} (${config.model})`);
}

/**
 * 从环境变量自动注册 providers（按用途：studio / pipeline / knowledge）
 *
 * config.env 格式：
 *   STUDIO_BASE_URL=...    STUDIO_API_KEY=...
 *   PIPELINE_BASE_URL=...  PIPELINE_API_KEY=...
 *   KNOWLEDGE_BASE_URL=... KNOWLEDGE_API_KEY=...
 *   MODEL_TIER_FAST=...    (gateway 默认模型)
 */
export function loadFromEnv(addFn: (config: ProviderConfig) => void): void {
  const purposes = [
    { name: 'studio', priority: 0 },
    { name: 'pipeline', priority: 1 },
    { name: 'knowledge', priority: 2 },
  ] as const;

  const defaultModel = process.env.MODEL_TIER_FAST || 'deepseek-v4-flash';

  for (const { name, priority } of purposes) {
    const baseUrl = process.env[`${name.toUpperCase()}_BASE_URL`];
    const apiKey = process.env[`${name.toUpperCase()}_API_KEY`];
    if (baseUrl && apiKey) {
      addFn({
        name,
        baseUrl,
        apiKey,
        model: defaultModel,
        priority,
      });
    }
  }

  // 兼容：遗留 provider-specific 环境变量（逐步废弃）
  if (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_BASE_URL) {
    addFn({
      name: 'anthropic-legacy',
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ANTHROPIC_MODEL || defaultModel,
      priority: 10,
      protocol: 'anthropic',
    });
  }
}

/**
 * 获取可用 providers 列表
 */
export function getProviders(providers: ProviderConfig[]): Array<{ name: string; model: string; priority: number; enabled: boolean }> {
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
export function isAvailable(providers: ProviderConfig[]): boolean {
  return providers.some(p => p.enabled !== false && !!p.apiKey);
}

/**
 * 根据请求解析可用 providers（角色过滤 + 指定 provider）
 */
export function resolveProviders(providers: ProviderConfig[], request: GatewayRequest): ProviderConfig[] {
  let filtered = providers.filter(p => p.enabled !== false && !!p.apiKey);

  // 角色权限过滤
  if (request.role) {
    filtered = filtered.filter(p => !p.allowedRoles || p.allowedRoles.length === 0 || p.allowedRoles.includes(request.role!));
  }

  // 指定 provider
  if (request.provider) {
    const named = filtered.filter(p => p.name === request.provider);
    if (named.length > 0) return named;
    logger.warn(`[Gateway] Requested provider "${request.provider}" not found, using default routing`);
  }

  return filtered;
}
