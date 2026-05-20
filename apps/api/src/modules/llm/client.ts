// LLM 客户端 - 支持 OpenAI 兼容 API
// Node.js 18+ 内置 fetch

import { logger } from '@dommaker/studio-shared';

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 检测可用的 LLM 配置（纯 env 驱动，无硬编码 key）
function detectConfig(): LLMConfig {
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    };
  }
  if (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY) {
    return {
      apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
    };
  }
  return {};
}

// 调用 LLM API
export async function callLLM(
  messages: ChatMessage[],
  config: LLMConfig = detectConfig()
): Promise<LLMResponse | null> {
  if (!config.apiKey) {
    logger.info('[LLM] No API key configured, skipping LLM call');
    return null;
  }

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.3, // 低温度，更确定性的输出
        max_tokens: 1000, // GLM-5 需要更多 token 用于 reasoning
      }),
    });

    if (!response.ok) {
      logger.error(`[LLM] API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string; reasoning_content?: string } }> | undefined;

    // GLM-5 返回 reasoning_content 而不是 content
    const content = choices?.[0]?.message?.content ||
                    choices?.[0]?.message?.reasoning_content || '';
    
    return {
      content,
      usage: data.usage as LLMResponse['usage'],
    };
  } catch (error) {
    logger.error('[LLM] Call failed', { error: String(error) });
    return null;
  }
}

// 检查 LLM 是否可用
export function isLLMAvailable(): boolean {
  const config = detectConfig();
  return !!config.apiKey;
}

// 获取当前 LLM 配置信息（不暴露 key）
export function getLLMInfo(): { available: boolean; model: string; provider: string } {
  const config = detectConfig();
  return {
    available: !!config.apiKey,
    model: config.model || 'none',
    provider: config.baseUrl?.includes('tencent') ? 'tencent' :
              config.baseUrl?.includes('deepseek') ? 'deepseek' : 
              config.baseUrl?.includes('openai') ? 'openai' : 'custom',
  };
}
