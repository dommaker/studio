// 创建意图分析器 - 从自然语言生成 Skill 配置
// 使用 /api/v1/llm/chat（统一使用 Studio LLM 配置）

import { logger } from '@dommaker/studio-shared';

// LLM API 端点（统一入口）
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
      logger.error('[Creation Analyzer] LLM error', { status: res.status });
      return null;
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    return {
      content: (data.content as string) || choices?.[0]?.message?.content || '',
    };
  } catch (error) {
    logger.error('[Creation Analyzer] LLM call failed', { error: String(error) });
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

export interface CreationIntent {
  type: 'skill';
  confidence: number;
  description: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  category: string;
  agent: 'codex' | 'claude';
  toolIds: string[];
  inputs: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  outputs: Array<{
    name: string;
    type: string;
    description: string;
  }>;
  execute?: {
    prompt?: string;
    steps?: string[];
  };
}

// 可用工具列表
const AVAILABLE_TOOLS = [
  'read', 'write', 'edit', 'exec', 'process',
  'web_search', 'web_fetch', 'jina_reader',
  'sessions_spawn', 'subagents', 'sessions_send',
];

// 分析创建意图
export async function analyzeCreationIntent(input: string): Promise<CreationIntent | null> {
  const available = await isLLMAvailable();
  if (!available) {
    // 回退到关键词匹配
    return fallbackIntentAnalysis(input);
  }

  const prompt = buildIntentPrompt(input);
  const response = await callLLM(prompt.messages);
  
  if (!response) {
    return fallbackIntentAnalysis(input);
  }

  return parseIntentResponse(response.content);
}

// 构建 intent 分析 prompt
function buildIntentPrompt(input: string): { messages: Record<string, unknown>[] } {
  const systemPrompt = `你是创建意图分析器。分析用户输入，生成 Skill 配置。

规则：
1. skill = 单个原子能力（如：分析代码、写测试、部署）
2. 返回 JSON 格式：{"type":"skill","confidence":0.0-1.0,"description":"用户想创建的内容描述"}`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `用户输入：${input}\n\n分析并返回JSON：` },
    ],
  };
}

// 解析 intent 响应
function parseIntentResponse(content: string): CreationIntent | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      type: 'skill',
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.7)),
      description: parsed.description || '',
    };
  } catch {
    return null;
  }
}

// 回退到关键词匹配
function fallbackIntentAnalysis(input: string): CreationIntent {
  return { type: 'skill', confidence: 0.7, description: input };
}

// 生成 Skill 配置
export async function generateSkillConfig(description: string): Promise<SkillConfig | null> {
  const available = await isLLMAvailable();
  if (!available) {
    return fallbackSkillConfig(description);
  }

  const prompt = buildSkillPrompt(description);
  const response = await callLLM(prompt.messages);
  
  if (!response) {
    return fallbackSkillConfig(description);
  }

  return parseSkillResponse(response.content, description);
}

// 构建 Skill 生成 prompt
function buildSkillPrompt(description: string): { messages: Record<string, unknown>[] } {
  const toolList = AVAILABLE_TOOLS.map(t => `- ${t}`).join('\n');
  
  const systemPrompt = `你是 Skill 配置生成器。根据用户描述生成完整的 Skill 配置。

可用工具：
${toolList}

返回 JSON 格式：
{
  "name": "skill-id（kebab-case）",
  "description": "技能描述",
  "category": "分类（development/testing/deployment/analysis/other）",
  "agent": "codex或claude",
  "toolIds": ["需要的工具"],
  "inputs": [
    {"name": "参数名", "type": "string", "required": true, "description": "说明"}
  ],
  "outputs": [
    {"name": "输出名", "type": "string", "description": "说明"}
  ],
  "execute": {
    "prompt": "执行时的提示词模板",
    "steps": ["步骤1", "步骤2"]
  }
}

规则：
1. name 必须是 kebab-case（如 analyze-code）
2. 根据描述推断需要的工具
3. agent 默认 codex，如需复杂推理用 claude
4. 输入输出要明确`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `描述：${description}\n\n生成配置JSON：` },
    ],
  };
}

// 解析 Skill 配置响应
function parseSkillResponse(content: string, fallbackDesc: string): SkillConfig | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      name: parsed.name || generateKebabName(fallbackDesc),
      description: parsed.description || fallbackDesc,
      category: parsed.category || 'other',
      agent: parsed.agent === 'claude' ? 'claude' : 'codex',
      toolIds: parsed.toolIds || ['read', 'write', 'exec'],
      inputs: parsed.inputs || [],
      outputs: parsed.outputs || [],
      execute: parsed.execute,
    };
  } catch {
    return null;
  }
}

// 回退 Skill 配置
function fallbackSkillConfig(description: string): SkillConfig {
  // 简单的关键词推断
  const toolIds: string[] = ['read', 'write', 'exec'];
  
  if (description.includes('测试')) {
    toolIds.push('process');
  }
  if (description.includes('部署')) {
    toolIds.push('exec', 'process');
  }
  if (description.includes('分析') || description.includes('搜索')) {
    toolIds.push('web_search', 'web_fetch');
  }
  
  return {
    name: generateKebabName(description),
    description,
    category: inferCategory(description),
    agent: 'codex',
    toolIds: [...new Set(toolIds)],
    inputs: [{ name: 'input', type: 'string', required: true, description: '输入内容' }],
    outputs: [{ name: 'result', type: 'string', description: '执行结果' }],
  };
}

// 推断分类
function inferCategory(description: string): string {
  if (/测试|test/i.test(description)) return 'testing';
  if (/部署|deploy|发布/i.test(description)) return 'deployment';
  if (/分析|analyze|检查/i.test(description)) return 'analysis';
  if (/开发|写|实现/i.test(description)) return 'development';
  return 'other';
}

// 生成 kebab-case 名称
function generateKebabName(description: string): string {
  // 提取中文关键词或英文单词
  const words = description
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)
    .slice(0, 3);
  
  if (words.length === 0) return 'custom-skill';
  
  // 简单翻译常见中文
  const translations: Record<string, string> = {
    '创建': 'create',
    '分析': 'analyze',
    '测试': 'test',
    '部署': 'deploy',
    '生成': 'generate',
    '检查': 'check',
    '代码': 'code',
    '文档': 'doc',
    '项目': 'project',
  };
  
  const translated = words.map(w => translations[w] || w.toLowerCase());
  return translated.join('-').substring(0, 30);
}
