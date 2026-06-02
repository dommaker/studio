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
 * 从环境变量自动注册 providers
 */
export function loadFromEnv(addFn: (config: ProviderConfig) => void): void {
  // Anthropic 协议 (Messages API) — 通过 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 检测
  if (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_BASE_URL) {
    const url = new URL(process.env.ANTHROPIC_BASE_URL);
    addFn({
      name: url.hostname,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      apiKey: process.env.ANTHROPIC_AUTH_TOKEN,
      model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro[1m]',
      priority: 0,
      protocol: 'anthropic',
    });
  }

  // OpenAI-compatible (DeepSeek 旧端点)
  if (process.env.DEEPSEEK_API_KEY) {
    addFn({
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      priority: 2,
    });
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
    addFn({
      name: 'openai',
      baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY!,
      model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
      priority: 3,
    });
  }

  // Tencent GLM
  if (process.env.CODING_API_KEY_1) {
    addFn({
      name: 'tencent',
      baseUrl: process.env.LLM_BASE_URL_TENCENT || 'https://api.lkeap.cloud.tencent.com/coding/v3',
      apiKey: process.env.CODING_API_KEY_1,
      model: process.env.LLM_MODEL_TENCENT || 'glm-5',
      priority: 4,
    });
  }

  // 用户配置（Settings 页面）
  if (process.env.LLM_API_KEY_USER) {
    addFn({
      name: 'user-config',
      baseUrl: process.env.LLM_BASE_URL_USER || 'https://api.openai.com/v1',
      apiKey: process.env.LLM_API_KEY_USER,
      model: process.env.LLM_MODEL_USER || 'gpt-3.5-turbo',
      priority: 1,
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
