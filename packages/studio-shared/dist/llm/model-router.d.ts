/**
 * Model Router — 类型定义 + 模型选择/路由逻辑 + 统一调用入口 + prompt 缓存
 *
 * P11-06: Extracted from model-gateway.ts
 * Types live here (central module) to avoid circular dependencies.
 */
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
export declare class PromptCache {
    private cache;
    get(request: GatewayRequest): GatewayResponse | undefined;
    set(request: GatewayRequest, response: GatewayResponse): void;
    private getKey;
}
/**
 * 统一调用入口（带 fallback）
 */
export declare function chat(request: GatewayRequest, providers: ProviderConfig[], usageLogRef: {
    log: UsageRecord[];
}, promptCache: PromptCache): Promise<GatewayResponse>;
/**
 * 简单调用（单条消息）
 */
export declare function prompt(text: string, systemPrompt: string | undefined, chatFn: (req: GatewayRequest) => Promise<GatewayResponse>, options?: Partial<GatewayRequest>): Promise<string>;
/**
 * 结构化输出（JSON）
 */
export declare function promptJson<T = any>(text: string, systemPrompt: string | undefined, chatFn: (req: GatewayRequest) => Promise<GatewayResponse>, options?: Partial<GatewayRequest>): Promise<T>;
/**
 * Extract JSON from potentially messy LLM output.
 */
export declare function extractJson<T = any>(text: string): T | undefined;
//# sourceMappingURL=model-router.d.ts.map