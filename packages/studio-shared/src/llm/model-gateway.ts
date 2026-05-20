/**
 * Model Gateway - 统一 LLM 调用网关
 *
 * 功能：多 provider 管理、优先级路由、自动 fallback、token 用量统计
 */

import { logger } from '../utils/logger.js';
import { createHash } from 'crypto';

declare const fetch: (url: string, init?: any) => Promise<any>;

// ─── 类型定义 ───

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  priority: number;
  maxTokens?: number;
  temperature?: number;
  enabled?: boolean;
  allowedRoles?: string[];
  protocol?: 'openai' | 'anthropic';
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GatewayRequest {
  messages: GatewayMessage[];
  model?: string;          // 覆盖默认模型
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  provider?: string;       // 指定 provider（跳过路由）
  role?: string;           // 调用方角色（用于权限过滤）
  cache?: boolean;         // 是否使用缓存（默认 true）
}

export interface GatewayResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface UsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  qualityScore?: number;  // 0-100
  error?: string;
}

export interface GatewayStats {
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  totalTokens: number;
  avgQualityScore: number;
  byProvider: Record<string, {
    calls: number;
    successes: number;
    totalTokens: number;
    avgLatencyMs: number;
    avgQualityScore: number;
  }>;
}

// ─── Provider 适配器 ───

interface RawResponse {
  id: string;
  model: string;
  choices: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callProvider(
  provider: ProviderConfig,
  messages: GatewayMessage[],
  options: { temperature?: number; maxTokens?: number; stream?: boolean }
): Promise<RawResponse> {
  const url = `${provider.baseUrl}/chat/completions`;
  const body = {
    model: provider.model,
    messages,
    temperature: options.temperature ?? provider.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    stream: options.stream ?? false,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`[${provider.name}] HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return response.json() as Promise<RawResponse>;
}

async function callAnthropicProvider(
  provider: ProviderConfig,
  messages: GatewayMessage[],
  options: { temperature?: number; maxTokens?: number; stream?: boolean }
): Promise<RawResponse> {
  const url = `${provider.baseUrl}/messages`;

  // Anthropic API 不接受 system role，需要提取为 top-level system 参数
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: m.content,
  }));

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    messages: chatMessages,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (options.temperature != null) body.temperature = options.temperature;
  if (options.stream) body.stream = true;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`[${provider.name}] HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  // 统一输出为 RawResponse 格式
  return {
    id: data.id || '',
    model: data.model || provider.model,
    choices: data.content?.map((block: any) => ({
      message: { content: block.text || '' },
      finish_reason: data.stop_reason || 'stop',
    })) || [],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined,
  };
}

// ─── Model Gateway ───

export class ModelGateway {
  private providers: ProviderConfig[] = [];
  private usageLog: UsageRecord[] = [];
  private maxLogSize = 10000;

  // Prompt 缓存（语义去重）
  private promptCache = new Map<string, { response: GatewayResponse; expiresAt: number }>();
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 分钟
  private readonly CACHE_MAX = 500;

  /**
   * 注册 provider
   */
  addProvider(config: ProviderConfig): void {
    this.providers.push({ ...config, enabled: config.enabled ?? true });
    this.providers.sort((a, b) => a.priority - b.priority);
    logger.info(`[Gateway] Provider registered: ${config.name} (${config.model})`);
  }

  /**
   * 从环境变量自动注册 providers
   */
  loadFromEnv(): void {
    // Anthropic 协议 (Messages API) — 通过 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 检测
    // 官方配置: export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
    if (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_BASE_URL) {
      const url = new URL(process.env.ANTHROPIC_BASE_URL);
      this.addProvider({
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
      this.addProvider({
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: process.env.DEEPSEEK_API_KEY,
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        priority: 2,
      });
    }

    // OpenAI
    if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) {
      this.addProvider({
        name: 'openai',
        baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
        apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY!,
        model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
        priority: 3,
      });
    }

    // Tencent GLM
    if (process.env.CODING_API_KEY_1) {
      this.addProvider({
        name: 'tencent',
        baseUrl: process.env.LLM_BASE_URL_TENCENT || 'https://api.lkeap.cloud.tencent.com/coding/v3',
        apiKey: process.env.CODING_API_KEY_1,
        model: process.env.LLM_MODEL_TENCENT || 'glm-5',
        priority: 4,
      });
    }

    // 用户配置（Settings 页面）
    if (process.env.LLM_API_KEY_USER) {
      this.addProvider({
        name: 'user-config',
        baseUrl: process.env.LLM_BASE_URL_USER || 'https://api.openai.com/v1',
        apiKey: process.env.LLM_API_KEY_USER,
        model: process.env.LLM_MODEL_USER || 'gpt-3.5-turbo',
        priority: 1,
      });
    }
  }

  /**
   * 统一调用入口（带 fallback）
   */
  async chat(request: GatewayRequest): Promise<GatewayResponse> {
    // Prompt 缓存检查
    const useCache = request.cache !== false;
    if (useCache) {
      const cacheKey = this.getCacheKey(request);
      const cached = this.promptCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug('[Gateway] Cache hit', { cacheKey: cacheKey.slice(0, 16) });
        return cached.response;
      }
    }

    const providers = this.resolveProviders(request);
    if (providers.length === 0) {
      throw new Error('[Gateway] No available providers. Configure LLM in Settings or environment variables.');
    }

    let lastError: Error | null = null;

    for (const provider of providers) {
      const startTime = Date.now();
      try {
        const call = provider.protocol === 'anthropic' ? callAnthropicProvider : callProvider;
        const raw = await call(provider, request.messages, {
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          stream: request.stream,
        });

        const latencyMs = Date.now() - startTime;
        const content = raw.choices?.[0]?.message?.content ||
                        raw.choices?.[0]?.message?.reasoning_content || '';

        const usage = raw.usage ? {
          promptTokens: raw.usage.prompt_tokens,
          completionTokens: raw.usage.completion_tokens,
          totalTokens: raw.usage.total_tokens,
        } : undefined;

        // 质量评分
        const qualityScore = this.scoreQuality(content, raw.choices?.[0]?.finish_reason, latencyMs);

        // 记录成功
        this.recordUsage({
          provider: provider.name,
          model: raw.model || provider.model,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          latencyMs,
          timestamp: Date.now(),
          success: true,
          qualityScore,
        });

        const response: GatewayResponse = { content, model: raw.model || provider.model, provider: provider.name, usage, latencyMs };

        // 写入缓存
        if (useCache) {
          this.setCache(this.getCacheKey(request), response);
        }

        return response;
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        lastError = error instanceof Error ? error : new Error(String(error));

        // 记录失败
        this.recordUsage({
          provider: provider.name,
          model: provider.model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          timestamp: Date.now(),
          success: false,
          error: lastError.message,
        });

        logger.warn(`[Gateway] ${provider.name} failed, trying next`, { error: lastError.message });
      }
    }

    throw new Error(`[Gateway] All providers failed. Last error: ${lastError?.message}`);
  }

  /**
   * 简单调用（单条消息）
   */
  async prompt(text: string, systemPrompt?: string): Promise<string> {
    const messages: GatewayMessage[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: text });

    const response = await this.chat({ messages });
    return response.content;
  }

  /**
   * 结构化输出（JSON）
   */
  async promptJson<T = any>(text: string, systemPrompt?: string): Promise<T> {
    const enhanced = `${text}\n\n请以 JSON 格式返回结果，不要包含其他文字。`;
    const response = await this.prompt(enhanced, systemPrompt);

    try {
      return JSON.parse(response);
    } catch {
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch?.[1]) return JSON.parse(jsonMatch[1].trim());

      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch?.[0]) return JSON.parse(objectMatch[0]);

      throw new Error('Failed to parse JSON from LLM response');
    }
  }

  /**
   * 获取可用 providers 列表
   */
  getProviders(): Array<{ name: string; model: string; priority: number; enabled: boolean }> {
    return this.providers.map(p => ({
      name: p.name,
      model: p.model,
      priority: p.priority,
      enabled: p.enabled ?? true,
    }));
  }

  /**
   * 获取用量统计
   */
  getStats(): GatewayStats {
    const byProvider: Record<string, { calls: number; successes: number; totalTokens: number; avgLatencyMs: number; avgQualityScore: number }> = {};

    for (const record of this.usageLog) {
      if (!byProvider[record.provider]) {
        byProvider[record.provider] = { calls: 0, successes: 0, totalTokens: 0, avgLatencyMs: 0, avgQualityScore: 0 };
      }
      const p = byProvider[record.provider];
      p.calls++;
      if (record.success) p.successes++;
      p.totalTokens += record.totalTokens;
      p.avgLatencyMs = Math.round((p.avgLatencyMs * (p.calls - 1) + record.latencyMs) / p.calls);
      if (record.qualityScore !== undefined) {
        p.avgQualityScore = Math.round((p.avgQualityScore * (p.calls - 1) + record.qualityScore) / p.calls);
      }
    }

    const totalCalls = this.usageLog.length;
    const successes = this.usageLog.filter(r => r.success).length;
    const qualityScores = this.usageLog.filter(r => r.qualityScore !== undefined).map(r => r.qualityScore!);

    return {
      totalCalls,
      successRate: totalCalls > 0 ? Math.round((successes / totalCalls) * 100) : 0,
      avgLatencyMs: totalCalls > 0
        ? Math.round(this.usageLog.reduce((sum, r) => sum + r.latencyMs, 0) / totalCalls)
        : 0,
      totalTokens: this.usageLog.reduce((sum, r) => sum + r.totalTokens, 0),
      avgQualityScore: qualityScores.length > 0
        ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
        : 0,
      byProvider,
    };
  }

  /**
   * 获取最近 N 条调用记录
   */
  getRecentUsage(n = 50): UsageRecord[] {
    return this.usageLog.slice(-n);
  }

  /**
   * 是否有可用 provider
   */
  isAvailable(): boolean {
    return this.providers.some(p => p.enabled !== false && !!p.apiKey);
  }

  // ─── 内部方法 ───

  private resolveProviders(request: GatewayRequest): ProviderConfig[] {
    let providers = this.providers.filter(p => p.enabled !== false && !!p.apiKey);

    // 角色权限过滤
    if (request.role) {
      providers = providers.filter(p => !p.allowedRoles || p.allowedRoles.length === 0 || p.allowedRoles.includes(request.role!));
    }

    // 指定 provider
    if (request.provider) {
      const named = providers.filter(p => p.name === request.provider);
      if (named.length > 0) return named;
      logger.warn(`[Gateway] Requested provider "${request.provider}" not found, using default routing`);
    }

    return providers;
  }

  private recordUsage(record: UsageRecord): void {
    this.usageLog.push(record);
    if (this.usageLog.length > this.maxLogSize) {
      this.usageLog = this.usageLog.slice(-this.maxLogSize / 2);
    }
  }

  // ─── Prompt 缓存 ───

  private getCacheKey(request: GatewayRequest): string {
    const payload = JSON.stringify(request.messages);
    return createHash('sha256').update(payload).digest('hex');
  }

  private setCache(key: string, response: GatewayResponse): void {
    // LRU 淘汰
    if (this.promptCache.size >= this.CACHE_MAX) {
      const oldest = this.promptCache.keys().next().value;
      if (oldest) this.promptCache.delete(oldest);
    }
    this.promptCache.set(key, { response, expiresAt: Date.now() + this.CACHE_TTL });
  }

  // ─── 质量评分 ───

  private scoreQuality(content: string, finishReason: string | undefined, latencyMs: number): number {
    let score = 50; // 基础分

    // 响应长度合理性（太短扣分，适中加分）
    if (content.length > 100) score += 15;
    else if (content.length > 20) score += 10;
    else if (content.length < 5) score -= 20;

    // finish_reason = stop 为正常结束
    if (finishReason === 'stop') score += 15;
    else if (finishReason === 'length') score -= 10;

    // 延迟评分（<2s 优，<5s 良，>10s 差）
    if (latencyMs < 2000) score += 20;
    else if (latencyMs < 5000) score += 10;
    else if (latencyMs > 10000) score -= 15;

    return Math.max(0, Math.min(100, score));
  }
}

// 单例
export const modelGateway = new ModelGateway();
