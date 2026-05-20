// LLM Client - LLM API 调用客户端
import { logger } from '../utils';

declare const fetch: (url: string, init?: any) => Promise<any>;

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
export class LLMClient {
  private config: LLMConfig;

  constructor(config?: Partial<LLMConfig>) {
    // 从环境变量读取配置
    this.config = {
      provider: (process.env.LLM_PROVIDER as LLMConfig['provider']) || 'tencent',
      apiKey: process.env.CODING_API_KEY_1 || process.env.ANTHROPIC_API_KEY_1 || '',
      baseUrl: process.env.LLM_BASE_URL || 'https://api.lkeap.cloud.tencent.com/coding/v3',
      model: process.env.LLM_MODEL || 'glm-5',
      ...config,
    };
  }

  /**
   * 调用 Chat Completion API
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const model = request.model || this.config.model;

    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 4096,
    };

    logger.debug('Calling LLM API', { url, model });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as ChatCompletionResponse;
      logger.debug('LLM API response', {
        usage: data.usage,
        finish_reason: data.choices[0]?.finish_reason,
      });

      return data;
    } catch (error) {
      logger.error('LLM API call failed', { error });
      throw error;
    }
  }

  /**
   * 简单调用 - 单次对话
   */
  async chat(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });

    const response = await this.chatCompletion({ messages });
    return response.choices[0]?.message?.content || '';
  }

  /**
   * 生成文本 embedding 向量
   */
  async embedding(text: string, model?: string): Promise<number[]> {
    const url = `${this.config.baseUrl}/embeddings`;
    const embeddingModel = model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: embeddingModel, input: text }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding || [];
  }

  /**
   * 结构化输出 - 要求返回 JSON
   */
  async chatJson<T = any>(prompt: string, systemPrompt?: string): Promise<T> {
    const enhancedPrompt = `${prompt}

请以 JSON 格式返回结果，不要包含其他文字。`;

    const response = await this.chat(enhancedPrompt, systemPrompt);
    
    // 尝试提取 JSON
    try {
      // 尝试直接解析
      return JSON.parse(response);
    } catch {
      // 尝试提取代码块中的 JSON
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        return JSON.parse(jsonMatch[1].trim());
      }
      
      // 尝试找到 JSON 对象
      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch && objectMatch[0]) {
        return JSON.parse(objectMatch[0]);
      }
      
      throw new Error('Failed to parse JSON from LLM response');
    }
  }
}

// 默认实例
export const llmClient = new LLMClient();
