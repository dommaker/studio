// LLM 意图分析器 - 使用 /api/v1/llm/chat（统一使用 Studio LLM 配置）

import { loadRegistry } from '../capabilities/routes.js';
import { logger } from '@dommaker/studio-shared';

// LLM API 端点（统一入口，端口 13001）
const LLM_API_URL = process.env.LLM_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1/llm/chat`;

// 调用 LLM（通过代理，使用 Studio LLM 配置）
async function callLLM(messages: Record<string, unknown>[]): Promise<{ content: string } | null> {
  try {
    const res = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.3 }),
    });

    if (!res.ok) {
      logger.error('[Intent Analyzer] LLM error', { status: res.status });
      return null;
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    return {
      content: (data.content as string) || choices?.[0]?.message?.content || '',
    };
  } catch (error) {
    logger.error('[Intent Analyzer] LLM call failed', { error: String(error) });
    return null;
  }
}

// 检查 LLM 是否可用
async function isLLMAvailable(): Promise<boolean> {
  try {
    const res = await fetch(LLM_API_URL.replace('/chat', '/status'));
    const data = await res.json() as Record<string, unknown>;
    return data.available === true;
  } catch {
    return false;
  }
}

export interface IntentResult {
  matchedCapability: string;
  capabilityType: 'skill' | 'workflow' | 'tool';
  confidence: number;
  reasoning?: string;
}

// 构建 LLM prompt
function buildPrompt(input: string, capabilities: Record<string, unknown>[]): { messages: Record<string, unknown>[] } {
  // 只保留 skill 和 workflow，限制数量，并添加详细说明
  const skillList = capabilities
    .filter(c => c.type === 'skill')
    .slice(0, 20)
    .map(c => {
      // 添加更明确的用途说明
      let usage = '';
      if (c.name === 'wf-analyze') usage = '（仅用于分析已有代码仓库架构）';
      if (c.name === 'wf-compare') usage = '（仅用于对比代码版本差异）';
      if (c.name === 'wf-deps') usage = '（仅用于分析项目依赖）';
      if (c.name === 'wf-perf') usage = '（仅用于分析性能瓶颈）';
      if (c.name === 'wf-arch') usage = '（用于设计架构方案）';
      if (c.name === 'wf-req') usage = '（用于需求分析）';
      if (c.name === 'wf-dev') usage = '（用于团队模式开发完整功能/系统）';
      if (c.name === 'wf-dev-fast') usage = '（用于团队模式快速开发）';
      if (c.name === 'wf-solo') usage = '（个人独立开发简单应用/小工具）';
      if (c.name === 'wf-solo-fast') usage = '（个人独立快速开发，并行前后端）';
      if (c.name === 'wf-turbo') usage = '（极速开发，跳过详细测试）';
      if (c.name === 'wf-iterate' || c.name === 'wf-iterate-v2') usage = '（在已有项目上迭代开发新功能）';
      if (c.name === 'wf-fe') usage = '（只开发前端）';
      if (c.name === 'wf-be') usage = '（只开发后端）';
      if (c.name === 'wf-test') usage = '（运行测试）';
      if (c.name === 'wf-review') usage = '（代码审查）';
      if (c.name === 'wf-deploy') usage = '（部署上线）';
      
      return `- ${c.name}: ${c.description} ${usage}`;
    })
    .join('\n');

  const workflowList = capabilities
    .filter(c => c.type === 'workflow')
    .slice(0, 15)
    .map(c => `- ${c.name}: ${c.description}`)
    .join('\n');

  const systemPrompt = `你是意图识别系统。根据用户输入匹配最合适的能力。

Skills（完整流程）:
${skillList}

Workflows（单个步骤）:
${workflowList}

规则：
1. 必须匹配用户意图和能力的实际用途
2. "调研外部产品"、"了解竞品" 等不是分析代码，不应匹配 research-arch
3. 如果没有合适的能力，返回 {"capability": null, "type": null, "confidence": 0, "reasoning": "无匹配能力"}
4. 优先选择 skill
5. 直接返回 JSON，格式：{"capability":"名称或null","type":"skill或workflow或null","confidence":0.0-1.0,"reasoning":"简短说明"}`;

  const userPrompt = `用户输入：${input}\n\n分析并返回JSON：`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}

// 解析 LLM 返回
function parseLLMResponse(content: string): IntentResult | null {
  try {
    // 尝试提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // 如果 LLM 返回 null，表示无匹配
    if (parsed.capability === null || parsed.capability === undefined) {
      return {
        matchedCapability: '',
        capabilityType: 'skill',
        confidence: 0,
        reasoning: parsed.reasoning || '无匹配能力',
      };
    }
    
    return {
      matchedCapability: parsed.capability,
      capabilityType: parsed.type || 'skill',
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    logger.error('[LLM] Failed to parse response', { content });
    return null;
  }
}

// 使用 LLM 分析意图
export async function analyzeIntentWithLLM(input: string): Promise<IntentResult | null> {
  try {
    const registry = loadRegistry();
    
    // 合并能力列表
    const capabilities = [
      ...registry.tools.map(c => ({ ...c, type: 'tool' as const })),
      ...registry.workflows.map(c => ({ ...c, type: 'workflow' as const })),
      ...registry.skills.map(c => ({ ...c, type: 'skill' as const })),
    ];
    
    const { messages } = buildPrompt(input, capabilities);

    const response = await callLLM(messages);
    
    if (!response) {
      return null;
    }

    return parseLLMResponse(response.content);
  } catch (error) {
    logger.error('[Intent Analyzer] Failed', { error: String(error) });
    return null;
  }
}

// 获取 LLM 状态
export async function getLLMStatus() {
  try {
    const res = await fetch(LLM_API_URL.replace('/chat', '/status'));
    return await res.json() as { available: boolean; model: string; provider: string };
  } catch {
    return { available: false, model: '', provider: '' };
  }
}
