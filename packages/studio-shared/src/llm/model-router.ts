/**
 * Model Router — 类型定义 + 模型选择/路由逻辑 + 统一调用入口 + prompt 缓存
 *
 * P11-06: Extracted from model-gateway.ts
 * Types live here (central module) to avoid circular dependencies.
 */

import { logger } from '../utils/logger.js';
import { createHash } from 'crypto';
import { resolveProviders } from './provider-registry.js';
import { recordUsage, scoreQuality } from './usage-tracker.js';

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
  tierModels?: Record<string, string>;
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GatewayRequest {
  messages: GatewayMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  provider?: string;
  role?: string;
  cache?: boolean;
  tier?: string;
}

export interface GatewayResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens?: number;
  };
  latencyMs: number;
}

export interface UsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  latencyMs: number;
  timestamp: number;
  success: boolean;
  qualityScore?: number;
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
    cache_read_tokens?: number;
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
      cache_read_tokens: data.usage.cache_read_input_tokens || (data.usage as any).cache_hit_tokens || 0,
    } : undefined,
  };
}

// ─── Prompt 缓存 ───

const CACHE_TTL = 10 * 60 * 1000; // 10 分钟
const CACHE_MAX = 500;

export class PromptCache {
  private cache = new Map<string, { response: GatewayResponse; expiresAt: number }>();

  get(request: GatewayRequest): GatewayResponse | undefined {
    const key = this.getKey(request);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug('[Gateway] Cache hit', { cacheKey: key.slice(0, 16) });
      return cached.response;
    }
    return undefined;
  }

  set(request: GatewayRequest, response: GatewayResponse): void {
    const key = this.getKey(request);
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { response, expiresAt: Date.now() + CACHE_TTL });
  }

  private getKey(request: GatewayRequest): string {
    const payload = JSON.stringify(request.messages);
    return createHash('sha256').update(payload).digest('hex');
  }
}

// ─── 调用入口 ───

/**
 * 统一调用入口（带 fallback）
 */
export async function chat(
  request: GatewayRequest,
  providers: ProviderConfig[],
  usageLogRef: { log: UsageRecord[] },
  promptCache: PromptCache,
): Promise<GatewayResponse> {
  const useCache = request.cache !== false;
  if (useCache) {
    const cached = promptCache.get(request);
    if (cached) return cached;
  }

  const resolved = resolveProviders(providers, request);
  if (resolved.length === 0) {
    throw new Error('[Gateway] No available providers. Configure LLM in Settings or environment variables.');
  }

  let lastError: Error | null = null;

  for (const provider of resolved) {
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

      if (!content) {
        logger.warn('[Gateway] Empty content from provider', {
          provider: provider.name,
          model: raw.model || provider.model,
          choiceCount: raw.choices?.length || 0,
          rawKeys: raw.choices?.[0] ? Object.keys(raw.choices[0]) : [],
          rawSample: JSON.stringify(raw).slice(0, 400),
        });
      }

      const usage = raw.usage ? {
        promptTokens: raw.usage.prompt_tokens,
        completionTokens: raw.usage.completion_tokens,
        totalTokens: raw.usage.total_tokens,
        cacheHitTokens: raw.usage.cache_read_tokens ?? 0,
      } : undefined;

      const quality = scoreQuality(content, raw.choices?.[0]?.finish_reason, latencyMs);

      usageLogRef.log = recordUsage(usageLogRef.log, {
        provider: provider.name,
        model: raw.model || provider.model,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        cacheHitTokens: usage?.cacheHitTokens ?? 0,
        latencyMs,
        timestamp: Date.now(),
        success: true,
        qualityScore: quality,
      });

      const response: GatewayResponse = { content, model: raw.model || provider.model, provider: provider.name, usage, latencyMs };

      if (useCache) {
        promptCache.set(request, response);
      }

      return response;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      lastError = error instanceof Error ? error : new Error(String(error));

      usageLogRef.log = recordUsage(usageLogRef.log, {
        provider: provider.name,
        model: provider.model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheHitTokens: 0,
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
export async function prompt(
  text: string,
  systemPrompt: string | undefined,
  chatFn: (req: GatewayRequest) => Promise<GatewayResponse>,
): Promise<string> {
  const messages: GatewayMessage[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: text });

  const response = await chatFn({ messages });
  return response.content;
}

/**
 * 结构化输出（JSON）
 */
export async function promptJson<T = any>(
  text: string,
  systemPrompt: string | undefined,
  chatFn: (req: GatewayRequest) => Promise<GatewayResponse>,
): Promise<T> {
  const enhanced = `${text}\n\n请以 JSON 格式返回结果，不要包含其他文字。`;
  const response = await prompt(enhanced, systemPrompt, chatFn);

  const parsed = extractJson<T>(response);
  if (parsed !== undefined) return parsed;

  logger.warn('[Gateway] Failed to parse JSON from LLM response', {
    responsePreview: response.slice(0, 300),
  });
  throw new Error('Failed to parse JSON from LLM response');
}

// ─── JSON 提取 ───

/**
 * Extract JSON from potentially messy LLM output.
 */
export function extractJson<T = any>(text: string): T | undefined {
  try { return JSON.parse(text); } catch {}

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock?.[1]) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  const objMatch = extractBalancedJson(text, '{', '}');
  if (objMatch) {
    try { return JSON.parse(objMatch); } catch {}
  }

  const arrMatch = extractBalancedJson(text, '[', ']');
  if (arrMatch) {
    try { return JSON.parse(arrMatch); } catch {}
  }

  return undefined;
}

function extractBalancedJson(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  if (start === -1) return undefined;

  let depth = 0;
  let bestEnd = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) {
        bestEnd = i;
      }
    }
  }
  return bestEnd > start ? text.slice(start, bestEnd + 1) : undefined;
}
