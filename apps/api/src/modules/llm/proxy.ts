// LLM 代理接口 - 从 process.env 读取配置
// 用户配置保存到 process.env（进程内存），服务重启后需重新保存

import { Router } from 'express';
import { logger } from '@dommaker/studio-shared';

const router = Router();

/**
 * 获取 LLM 配置
 * 优先级：用户配置（process.env.LLM_API_KEY_USER）> 环境变量配置
 */
function getLLMConfig(): { apiKey: string; baseUrl: string; model: string; provider: string } | null {
  // 1. 优先读取用户配置（Settings 页面保存）
  const userApiKey = process.env.LLM_API_KEY_USER;
  const userBaseUrl = process.env.LLM_BASE_URL_USER;
  const userModel = process.env.LLM_MODEL_USER;
  
  if (userApiKey) {
    return {
      apiKey: userApiKey,
      baseUrl: userBaseUrl || 'https://api.openai.com/v1',
      model: userModel || 'gpt-3.5-turbo',
      provider: 'user-config',
    };
  }
  
  // 2. 其次读取环境变量配置（管理员配置，适用于 runtime 用户）
  const apiKey = process.env.STUDIO_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.STUDIO_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL || 'deepseek-v4-flash';
  
  if (!apiKey) {
    return null;
  }
  
  return {
    apiKey,
    baseUrl,
    model,
    provider: baseUrl.includes('deepseek') ? 'deepseek' : 
              baseUrl.includes('openai') ? 'openai' : 'env-config',
  };
}

// 获取 LLM 状态
router.get('/status', (req, res) => {
  const config = getLLMConfig();
  
  res.json({
    available: !!config,
    model: config?.model || null,
    provider: config?.provider || null,
    configured: !!config?.apiKey,
    isUserConfig: config?.provider === 'user-config',
  });
});

// 获取可用的模型列表
router.get('/models', (req, res) => {
  const config = getLLMConfig();
  if (!config) {
    res.status(503).json({ 
      error: 'LLM not configured. Configure in Settings page.' 
    });
    return;
  }
  
  res.json({
    available: true,
    model: config.model,
    provider: config.provider,
  });
});

// Chat completions 代理
router.post('/chat', async (req, res) => {
  const config = getLLMConfig();
  if (!config) {
    res.status(503).json({ 
      error: 'LLM not configured',
      hint: 'Configure in Settings page (Studio users) or set environment variables: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL (runtime users)'
    });
    return;
  }
  
  const { messages, temperature = 0.7, max_tokens = 2000, stream = false } = req.body;
  
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'Messages array is required' });
    return;
  }
  
  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature,
          max_tokens,
          stream: true,
        }),
      });
      
      if (!response.ok) {
        res.write(`data: ${JSON.stringify({ error: response.statusText })}\n\n`);
        res.end();
        return;
      }
      
      const reader = response.body?.getReader();
      if (!reader) {
        res.write(`data: ${JSON.stringify({ error: 'No response body' })}\n\n`);
        res.end();
        return;
      }
      
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      
      res.end();
    } else {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature,
          max_tokens,
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('[LLM Proxy] API error', { status: response.status, errorText });
        res.status(response.status).json({ error: response.statusText });
        return;
      }
      
      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<{ message?: { content?: string; reasoning_content?: string } }> | undefined;
      const content = choices?.[0]?.message?.content ||
                      choices?.[0]?.message?.reasoning_content || '';
      
      res.json({
        id: data.id,
        model: data.model,
        content,
        usage: data.usage,
      });
    }
  } catch (error) {
    logger.error('[LLM Proxy] Error', { error: String(error) });
    res.status(500).json({ error: 'LLM request failed' });
  }
});

/**
 * POST /api/v1/llm/config
 * 保存用户配置到 process.env（进程内存）
 * 注意：服务重启后需重新保存
 */
router.get('/config/status', (req, res) => {
  const hasUserConfig = !!process.env.LLM_API_KEY_USER;
  
  res.json({
    hasUserConfig,
    config: hasUserConfig ? {
      baseUrl: process.env.LLM_BASE_URL_USER,
      model: process.env.LLM_MODEL_USER,
    } : null,
    message: hasUserConfig ? '用户配置已生效' : '用户配置未保存（服务可能已重启）',
  });
});

router.post('/config', (req, res) => {
  const { apiKey, baseUrl, model } = req.body;
  
  if (!apiKey) {
    return res.status(400).json({
      success: false,
      error: 'apiKey is required',
    });
  }
  
  // 存到 process.env（带 _USER 后缀，区分用户配置和系统配置）
  process.env.LLM_API_KEY_USER = apiKey;
  process.env.LLM_BASE_URL_USER = baseUrl || 'https://api.openai.com/v1';
  process.env.LLM_MODEL_USER = model || 'gpt-3.5-turbo';
  
  logger.info('[LLM Proxy] User config saved to process.env');
  logger.info(`  baseUrl: ${process.env.LLM_BASE_URL_USER}`);
  logger.info(`  model: ${process.env.LLM_MODEL_USER}`);
  
  res.json({
    success: true,
    message: '配置已保存到服务器内存（服务重启后需重新保存）',
    config: {
      baseUrl: process.env.LLM_BASE_URL_USER,
      model: process.env.LLM_MODEL_USER,
    },
  });
});

export default router;
