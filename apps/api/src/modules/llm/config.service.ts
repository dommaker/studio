/**
 * LLM Config Service - 加密存储 + 分层配置解析
 *
 * §12.11: UI 配置 → AES-256-GCM 加密存 DB → 分层下发给各消费方
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { encrypt, decrypt } from '../../utils/crypto.js';

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
  apiKey: string;
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
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

// ─── Service ───

export class LLMConfigService {
  /**
   * 保存 LLM 配置（加密存储）
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

    const enc = encrypt(input.apiKey);

    const config = await prisma.lLMConfig.upsert({
      where: {
        scope_provider: { scope: input.scope, provider: input.provider },
      },
      create: {
        scope: input.scope,
        provider: input.provider,
        baseUrl: input.baseUrl || null,
        apiKeyEnc: enc.encrypted,
        apiKeyIv: enc.iv,
        apiKeyTag: enc.tag,
        model: input.model,
        options: JSON.stringify(input.options || {}),
        isActive: true,
      },
      update: {
        baseUrl: input.baseUrl || null,
        apiKeyEnc: enc.encrypted,
        apiKeyIv: enc.iv,
        apiKeyTag: enc.tag,
        model: input.model,
        options: JSON.stringify(input.options || {}),
        isActive: true,
      },
    });

    logger.info(`[LLM Config] Saved: ${config.scope}/${config.provider}`);
    return this.maskConfig(config);
  }

  /**
   * 获取指定 scope 的配置列表（脱敏）
   */
  async getConfigs(scope?: string): Promise<MaskedLLMConfig[]> {
    const configs = await prisma.lLMConfig.findMany({
      where: scope ? { scope, isActive: true } : { isActive: true },
      orderBy: [{ scope: 'asc' }, { provider: 'asc' }],
    });

    return configs.map(c => this.maskConfig(c));
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
    await prisma.lLMConfig.delete({ where: { id } });
    logger.info(`[LLM Config] Deleted: ${id}`);
  }

  /**
   * 测试配置连通性
   */

  /**
   * 将 DB 中的配置注册到 ModelGateway
   * 启动时调用一次，配置变更时可重新调用
   */
  async syncToGateway(): Promise<number> {
    const configs = await prisma.lLMConfig.findMany({
      where: { isActive: true },
    });

    let registered = 0;

    // 按 scope 分组，取 studio scope 注册到 gateway
    for (const config of configs) {
      if (config.scope !== 'studio' && config.scope !== 'orchestrator') continue;

      try {
        const apiKey = decrypt({
          encrypted: config.apiKeyEnc,
          iv: config.apiKeyIv,
          tag: config.apiKeyTag,
        });

        const defaults = PROVIDER_DEFAULTS[config.provider] || {} as { baseUrl?: string; model?: string };
        const opts = typeof config.options === 'string' ? JSON.parse(config.options) : (config.options || {});

        modelGateway.addProvider({
          name: `${config.scope}:${config.provider}`,
          baseUrl: config.baseUrl || defaults.baseUrl || '',
          apiKey,
          model: config.model || defaults.model || '',
          priority: config.scope === 'orchestrator' ? 0 : 1,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
        });

        registered++;
      } catch (error) {
        logger.warn(`[LLM Config] Failed to register ${config.scope}/${config.provider}`, { error: String(error) });
      }
    }

    logger.info(`[LLM Config] Synced ${registered} configs to ModelGateway`);
    return registered;
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

  private async findActiveConfig(scope: string) {
    return prisma.lLMConfig.findFirst({
      where: { scope, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private toResolved(config: any, source: string): ResolvedLLMConfig {
    let apiKey: string;
    try {
      apiKey = decrypt({
        encrypted: config.apiKeyEnc,
        iv: config.apiKeyIv,
        tag: config.apiKeyTag,
      });
    } catch (error) {
      throw new Error(`Failed to decrypt API key for config ${config.id} (scope: ${config.scope}, provider: ${config.provider}): ${String(error)}`);
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

    // 系统配置
    if (process.env.DEEPSEEK_API_KEY) {
      return {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
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
    // 从加密数据解密后只取后 4 位
    let apiKeyLast4 = '****';
    try {
      const decrypted = decrypt({
        encrypted: config.apiKeyEnc,
        iv: config.apiKeyIv,
        tag: config.apiKeyTag,
      });
      apiKeyLast4 = `****${decrypted.slice(-4)}`;
    } catch {
      apiKeyLast4 = '****(decrypt-error)';
    }

    return {
      id: config.id,
      scope: config.scope,
      provider: config.provider,
      baseUrl: config.baseUrl,
      apiKeyMasked: apiKeyLast4,
      model: config.model,
      options: config.options,
      isActive: config.isActive,
    };
  }
}

export const llmConfigService = new LLMConfigService();
