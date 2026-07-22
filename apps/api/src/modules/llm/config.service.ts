/**
 * LLM Config Service - 分层配置解析
 *
 * UI 配置 → FileStore（scope/provider/model/options）→ API key 从 config.env 解析
 */

import { randomUUID } from 'crypto';
import path from 'node:path';
import os from 'node:os';
import { logger, FileStore } from '@dommaker/studio-shared';
import type { LlmProvider } from '@dommaker/studio-shared';

// ─── 类型 ───

export type LLMConfigScope =
  | 'orchestrator'
  | 'agent_codex'
  | 'agent_claude'
  | 'agent_opencode'
  | 'agent_default'
  | 'studio';

export type LLMProvider = 'anthropic' | 'openai' | 'tencent' | 'deepseek' | 'custom';

export interface LLMConfigInput {
  scope: LLMConfigScope;
  provider: LLMProvider;
  baseUrl?: string;
  model: string;
  options?: Record<string, any>;
}

export interface ResolvedLLMConfig {
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  options?: Record<string, any>;
  source: string; // 配置来源：scope 名称 / env / default
}

export interface MaskedLLMConfig {
  id: string;
  scope: string;
  provider: string;
  baseUrl: string | null;
  apiKeyMasked: string; // 只显示后 4 位
  model: string;
  options: Record<string, any> | null;
  isActive: boolean;
}

// ─── 默认配置（无 key，仅 provider/model/baseUrl 的合理默认） ───

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  tencent: { baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3', model: 'glm-5' },
  deepseek: { baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

// ─── Service ───

const fileStore = new FileStore();
const CONFIGS_PATH = path.join(os.homedir(), '.studio', 'llm-configs.json');

interface LLMConfigRecord {
  id: string;
  scope: string;
  provider: string;
  baseUrl: string | null;
  model: string;
  options: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function maskRecord(c: LLMConfigRecord): any {
  return {
    id: c.id,
    scope: c.scope,
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    options: c.options,
    isActive: c.isActive,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export class LLMConfigService {
  private async readConfigs(): Promise<LLMConfigRecord[]> {
    return (await fileStore.readJson<LLMConfigRecord[]>(CONFIGS_PATH)) ?? [];
  }

  private async writeConfigs(configs: LLMConfigRecord[]): Promise<void> {
    await fileStore.writeJson(CONFIGS_PATH, configs);
  }

  /**
   * 保存 LLM 配置（scope/provider/model/options，API key 从 env 解析）
   */
  async saveConfig(input: LLMConfigInput): Promise<MaskedLLMConfig> {
    // 验证 scope 和 provider
    const validScopes: LLMConfigScope[] = ['orchestrator', 'agent_codex', 'agent_claude', 'agent_opencode', 'agent_default', 'studio'];
    const validProviders: LLMProvider[] = ['anthropic', 'openai', 'tencent', 'deepseek', 'custom'];
    if (!validScopes.includes(input.scope)) {
      throw new Error(`Invalid scope: ${input.scope}. Valid: ${validScopes.join(', ')}`);
    }
    if (!validProviders.includes(input.provider)) {
      throw new Error(`Invalid provider: ${input.provider}. Valid: ${validProviders.join(', ')}`);
    }

    const configs = await this.readConfigs();
    const idx = configs.findIndex(c => c.scope === input.scope && c.provider === input.provider);
    const now = new Date().toISOString();

    let config: LLMConfigRecord;
    if (idx >= 0) {
      configs[idx] = config = {
        ...configs[idx],
        baseUrl: input.baseUrl || null,
        model: input.model,
        options: JSON.stringify(input.options || {}),
        isActive: true,
        updatedAt: now,
      };
    } else {
      config = {
        id: randomUUID(),
        scope: input.scope,
        provider: input.provider,
        baseUrl: input.baseUrl || null,
        model: input.model,
        options: JSON.stringify(input.options || {}),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      configs.push(config);
    }

    await this.writeConfigs(configs);

    logger.info(`[LLM Config] Saved: ${config.scope}/${config.provider}`);
    return this.maskConfig(config);
  }

  /**
   * 获取指定 scope 的配置列表（脱敏）
   */
  async getConfigs(scope?: string): Promise<MaskedLLMConfig[]> {
    const configs = await this.readConfigs();
    const filtered = scope
      ? configs.filter(c => c.scope === scope && c.isActive)
      : configs.filter(c => c.isActive);

    filtered.sort((a, b) => a.scope.localeCompare(b.scope) || a.provider.localeCompare(b.provider));
    return filtered.map(c => this.maskConfig(c));
  }

  /**
   * 解析配置（分层查找）
   * 优先级：精确 scope → agent_default(仅 agent_*) → env → 报错
   */
  async resolve(scope: LLMConfigScope): Promise<ResolvedLLMConfig> {
    // 1. 精确匹配
    const exact = await this.findActiveConfig(scope);
    if (exact) return this.toResolved(exact, scope);

    // 2. agent_* scope 降级到 agent_default
    if (scope.startsWith('agent_')) {
      const fallback = await this.findActiveConfig('agent_default');
      if (fallback) return this.toResolved(fallback, 'agent_default');
    }

    // 3. 环境变量兜底
    const envConfig = this.resolveFromEnv();
    if (envConfig) return envConfig;

    throw new Error(`No LLM config found for scope "${scope}". Configure in Settings or set environment variables.`);
  }

  /**
   * 删除配置
   */
  async deleteConfig(id: string): Promise<void> {
    const configs = await this.readConfigs();
    const filtered = configs.filter(c => c.id !== id);
    if (filtered.length === configs.length) {
      throw new Error(`LLMConfig not found: ${id}`);
    }
    await this.writeConfigs(filtered);
    logger.info(`[LLM Config] Deleted: ${id}`);
  }

  /**
   * 测试配置连通性
   */
  async testConfig(scope: LLMConfigScope): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    try {
      const config = await this.resolve(scope);
      const start = Date.now();

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      });

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { success: false, latencyMs, error: `HTTP ${response.status}: ${errorText.slice(0, 100)}` };
      }

      return { success: true, latencyMs };
    } catch (error) {
      return { success: false, latencyMs: 0, error: String(error) };
    }
  }

  // ─── 内部方法 ───

  private resolveApiKey(provider: string): string | undefined {
    const envMap: Record<string, string> = {
      deepseek: 'DEEPSEEK_API_KEY',
      anthropic: 'ANTHROPIC_AUTH_TOKEN',
      openai: 'OPENAI_API_KEY',
      coding: 'CODING_API_KEY_1',
    };
    const envKey = envMap[provider];
    return envKey ? process.env[envKey] || undefined : undefined;
  }

  private async findActiveConfig(scope: string) {
    const configs = await this.readConfigs();
    return configs
      .filter(c => c.scope === scope && c.isActive)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
  }

  private toResolved(config: any, source: string): ResolvedLLMConfig {
    const apiKey = this.resolveApiKey(config.provider as string);
    if (!apiKey) {
      throw new Error(`No API key in environment for provider "${config.provider}" (scope: ${config.scope}). Set the appropriate env var in ~/.studio/config.env`);
    }

    const defaults = PROVIDER_DEFAULTS[config.provider] || {} as { baseUrl?: string; model?: string };
    const opts = typeof config.options === 'string' ? JSON.parse(config.options) : (config.options || {});

    return {
      provider: config.provider,
      baseUrl: config.baseUrl || defaults.baseUrl || '',
      apiKey,
      model: config.model || defaults.model || '',
      options: opts,
      source,
    };
  }

  private resolveFromEnv(): ResolvedLLMConfig | null {
    // 用户配置优先
    if (process.env.LLM_API_KEY_USER) {
      return {
        provider: 'custom',
        baseUrl: process.env.LLM_BASE_URL_USER || 'https://api.openai.com/v1',
        apiKey: process.env.LLM_API_KEY_USER,
        model: process.env.LLM_MODEL_USER || 'gpt-3.5-turbo',
        source: 'env:user',
      };
    }

    // 系统配置 — 直接读 provider env key（不再走 STUDIO_API_KEY 统一密钥）
    if (process.env.DEEPSEEK_API_KEY) {
      return {
        provider: 'deepseek',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        source: 'env:deepseek',
      };
    }

    if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
      return {
        provider: 'openai',
        baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY!,
        model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
        source: 'env:openai',
      };
    }

    if (process.env.CODING_API_KEY_1) {
      return {
        provider: 'tencent',
        baseUrl: process.env.LLM_BASE_URL_TENCENT || 'https://api.lkeap.cloud.tencent.com/coding/v3',
        apiKey: process.env.CODING_API_KEY_1,
        model: process.env.LLM_MODEL_TENCENT || 'glm-5',
        source: 'env:tencent',
      };
    }

    return null;
  }

  private maskConfig(config: any): MaskedLLMConfig {
    const apiKey = this.resolveApiKey(config.provider as string);
    const apiKeyMasked = apiKey ? `****${apiKey.slice(-4)}` : '****(not-set)';

    return {
      id: config.id,
      scope: config.scope,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKeyMasked,
      model: config.model,
      options: config.options,
      isActive: config.isActive,
    };
  }
}

export const llmConfigService = new LLMConfigService();
