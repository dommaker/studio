export interface LLMConfig {
    provider: 'tencent' | 'anthropic' | 'openai';
    apiKey: string;
    baseUrl: string;
    model: string;
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ChatCompletionRequest {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    max_tokens?: number;
}
export interface ChatCompletionResponse {
    id: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
/**
 * LLM 客户端
 */
export declare class LLMClient {
    private config;
    constructor(config?: Partial<LLMConfig>);
    /**
     * 调用 Chat Completion API
     */
    chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
    /**
     * 简单调用 - 单次对话
     */
    chat(prompt: string, systemPrompt?: string): Promise<string>;
    /**
     * 生成文本 embedding 向量
     */
    embedding(text: string, model?: string): Promise<number[]>;
    /**
     * 结构化输出 - 要求返回 JSON
     */
    chatJson<T = any>(prompt: string, systemPrompt?: string): Promise<T>;
}
export declare const llmClient: LLMClient;
//# sourceMappingURL=llm-client.d.ts.map