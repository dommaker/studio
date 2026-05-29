import { requireNotGuest, requireRole } from '../../middleware/auth.js';  // SEC-001 / SEC-002
// skills/routes.ts - Tool 管理 API（tools/std 目录）
// 命名澄清：这些是 tools，不是独立的 "skill" 类型
// 系统只有 workflows + tools 两种类型
import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getToolsDir } from '@dommaker/harness';

import { logger } from '@dommaker/studio-shared';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';
import { getErrorMessage } from '../../utils/errors.js';

const router = Router();

const TOOLS_STD_PATH = process.env.AGENT_WORKFLOWS_TOOLS_STD_PATH
  || path.join(getToolsDir(), 'std');

// Tool 类型定义（修正：type 应为 'tool'）
interface StdTool {
  id: string;
  name: string;
  description: string;
  category: string;
  type: 'tool';  // tools/std 下的文件也是 tool 类型
  agent: 'codex' | 'claude';
  toolIds: string[];
  version?: string;
  inputs?: Record<string, unknown>[];
  outputs?: Record<string, unknown>[];
  execute?: Record<string, unknown>;
  path: string;
  createdAt?: string;
  updatedAt?: string;
}

// 清理 category 参数，防止路径遍历
function sanitizeCategory(category: string): string {
  return category
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

// 确保目录存在（async）
async function ensureCategoryDir(category: string): Promise<string> {
  const sanitized = sanitizeCategory(category);
  const dir = path.join(TOOLS_STD_PATH, sanitized);
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

// 生成 Tool ID（从名称生成）
function generateStepId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 获取 Tool 文件路径
function getStepFilePath(category: string, id: string): string {
  const sanitized = sanitizeCategory(category);
  return path.join(TOOLS_STD_PATH, sanitized, `${id}.yml`);
}

// 读取 Tool 文件（async）
async function readStepFile(filePath: string): Promise<StdTool | null> {
  try {
    await fsPromises.access(filePath);
  } catch {
    return null;
  }

  try {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    const data = yaml.load(content) as Record<string, unknown>;

    const relativePath = path.relative(TOOLS_STD_PATH, filePath);
    const category = relativePath.split(path.sep)[0] || 'other';
    const stats = await fsPromises.stat(filePath);

    return {
      id: (data.name as string) || path.basename(filePath, '.yml'),
      name: (data.name as string) || path.basename(filePath, '.yml'),
      description: (data.description as string) || '',
      category: (data.category as string) || category,
      type: 'tool',
      agent: (data.agent as 'codex' | 'claude') || 'codex',
      toolIds: (data.toolIds as string[]) || [],
      version: (data.version as string) || '1.0.0',
      inputs: (data.inputs as Record<string, unknown>[]) || [],
      outputs: (data.outputs as Record<string, unknown>[]) || [],
      execute: (data.execute as Record<string, unknown>) || {},
      path: relativePath.replace(/\\/g, '/'),
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
    };
  } catch (error) {
    logger.error('Failed to read step file', { error: getErrorMessage(error) });
    return null;
  }
}

// 写入 Skill 文件（async）
async function writeStepFile(step: Partial<StdTool>): Promise<{ success: boolean; error?: string; path?: string }> {
  try {
    const category = step.category || 'other';
    const id = step.id || generateStepId(step.name || 'unnamed-step');

    const dir = await ensureCategoryDir(category);
    const filePath = path.join(dir, `${id}.yml`);

    const yamlData: Record<string, unknown> = {
      name: step.name || id,
      description: step.description || '',
      category: category,
      version: step.version || '1.0.0',
      agent: step.agent || 'codex',
      toolIds: step.toolIds || [],
    };

    if (step.inputs && step.inputs.length > 0) {
      yamlData.inputs = step.inputs;
    }

    if (step.outputs && step.outputs.length > 0) {
      yamlData.outputs = step.outputs;
    }

    if (step.execute) {
      yamlData.execute = step.execute;
    }

    const yamlContent = yaml.dump(yamlData, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    await fsPromises.writeFile(filePath, yamlContent, 'utf-8');

    return {
      success: true,
      path: `${category}/${id}.yml`,
    };
  } catch (error) {
    logger.error('Failed to write step file', { error: getErrorMessage(error) });
    return {
      success: false,
      error: getErrorMessage(error) || '写入文件失败',
    };
  }
}

// 删除 Skill 文件（async）
async function deleteStepFile(category: string, id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const filePath = getStepFilePath(category, id);

    try {
      await fsPromises.access(filePath);
    } catch {
      return { success: false, error: 'Skill 文件不存在' };
    }

    await fsPromises.unlink(filePath);
    return { success: true };
  } catch (error) {
    logger.error('Failed to delete step file', { error: getErrorMessage(error) });
    return {
      success: false,
      error: getErrorMessage(error) || '删除文件失败',
    };
  }
}

// 扫描所有 Skill 文件（async）
async function scanAllSteps(): Promise<StdTool[]> {
  const steps: StdTool[] = [];

  try {
    try {
      await fsPromises.access(TOOLS_STD_PATH);
    } catch {
      return steps;
    }

    const entries = await fsPromises.readdir(TOOLS_STD_PATH, { withFileTypes: true });
    const categories = entries
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const category of categories) {
      const categoryPath = path.join(TOOLS_STD_PATH, category);
      const files = await fsPromises.readdir(categoryPath);
      const yamlFiles = files.filter(file => file.endsWith('.yml') || file.endsWith('.yaml'));

      for (const file of yamlFiles) {
        const filePath = path.join(categoryPath, file);
        const step = await readStepFile(filePath);
        if (step) {
          steps.push(step);
        }
      }
    }
  } catch (error) {
    logger.error('Failed to scan steps', { error: getErrorMessage(error) });
  }

  return steps;
}

// ==================== API 路由 ====================

// GET /api/v1/skills - 获取所有 Skill
router.get('/', async (req: Request, res: Response) => {
  try {
    const skills = await scanAllSteps();
    res.json({
      success: true,
      skills,
      total: skills.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error) || '获取技能列表失败',
    });
  }
});

// GET /api/v1/skills/:id - 获取单个 Step
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { category } = req.query;

    if (category) {
      const filePath = getStepFilePath(category as string, id);
      const step = await readStepFile(filePath);

      if (!step) {
        return res.status(404).json({ success: false, error: 'Skill 不存在' });
      }

      return res.json({ success: true, step });
    }

    const steps = await scanAllSteps();
    const step = steps.find(s => s.id === id);

    if (!step) {
      return res.status(404).json({ success: false, error: 'Skill 不存在' });
    }

    res.json({ success: true, step });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error) || '获取步骤详情失败',
    });
  }
});

// POST /api/v1/skills - 创建 Step
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, category, agent, toolIds, inputs, outputs, execute } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: '步骤名称不能为空' });
    }

    if (!toolIds || toolIds.length === 0) {
      return res.status(400).json({ success: false, error: '至少需要一个工具' });
    }

    const id = generateStepId(name);
    const stepCategory = category || 'custom';

    const existingPath = getStepFilePath(stepCategory, id);
    try {
      await fsPromises.access(existingPath);
      return res.status(409).json({ success: false, error: '步骤名称已存在，请使用其他名称' });
    } catch {
      // File doesn't exist, continue
    }

    const result = await writeStepFile({
      id,
      name,
      description: description || '',
      category: stepCategory,
      agent: agent || 'codex',
      toolIds,
      inputs,
      outputs,
      execute,
    });

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    const step = await readStepFile(getStepFilePath(stepCategory, id));

    res.status(201).json({
      success: true,
      step,
      message: '步骤创建成功',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error) || '创建步骤失败',
    });
  }
});

// POST /api/v1/skills/generate - AI 生成 Skill 配置
// OpenClaw 配置路径（可通过环境变量自定义）
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');

// 从 OpenClaw 配置中获取 LLM 配置
async function getOpenClawLLMConfig(): Promise<{ apiKey: string; baseUrl: string; model: string; provider: string } | null> {
  try {
    const content = await fsPromises.readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content);

    const primaryModel = config.agents?.defaults?.model?.primary;
    if (!primaryModel) return null;

    const [providerName, modelName] = primaryModel.split('/');
    const providerConfig = config.models?.providers?.[providerName];

    if (!providerConfig) return null;

    let apiKey = providerConfig.apiKey;
    if (apiKey && !apiKey.startsWith('sk-')) {
      apiKey = process.env[apiKey] || apiKey;
    }

    return {
      apiKey,
      baseUrl: providerConfig.baseUrl,
      model: modelName || providerConfig.models?.[0]?.id || 'glm-5',
      provider: providerName,
    };
  } catch (error) {
    logger.error('[Skills] Failed to load OpenClaw config', { error: getErrorMessage(error) });
    return null;
  }
}

router.post('/generate', async (req: Request, res: Response) => {
  const config = await getOpenClawLLMConfig();
  if (!config) {
    res.status(503).json({ error: 'LLM not configured' });
    return;
  }

  const { description, context } = req.body;

  if (!description) {
    res.status(400).json({ error: 'Description is required' });
    return;
  }

  const systemPrompt = `你是一个 Skill 配置生成器。根据用户描述生成 YAML 格式的 Skill 配置。

Skill 是可复用的执行能力，包含：
1. 基本信息：id, name, description
2. 执行配置：agent, tools, prompt
3. 输入输出定义

输出格式要求：
- 必须输出有效的 YAML
- 包含所有必需字段：id, name, description, agent, prompt
- id 使用英文小写和连字符
- agent 可以是 codex 或 claude

示例输出：
\`\`\`yaml
id: analyze-requirements
name: 需求分析
description: 分析需求，生成标准化需求文档
agent: codex
temperature: 0.3
tools:
  - file-read
  - file-write
prompt: |
  你是一个需求分析师。分析以下需求：
  {{requirement}}
\`\`\`

现在根据用户描述生成 Skill 配置。只输出 YAML，不要其他解释。`;

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `需求描述：${description}\n\n上下文：${context || '无'}` },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[Skills] LLM API error', { error: errorText });
      res.status(500).json({ error: 'LLM API error' });
      return;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '';

    const yamlMatch = content.match(/```yaml\n([\s\S]*?)\n```/) ||
                      content.match(/```\n([\s\S]*?)\n```/) ||
                      [null, content];

    const yamlContent = yamlMatch[1] || content;

    try {
      const parsed = yaml.load(yamlContent) as Record<string, unknown> | undefined;

      if (!parsed?.id || !parsed?.name) {
        res.status(400).json({ error: 'Generated YAML missing required fields' });
        return;
      }

      res.json({
        success: true,
        skill: parsed,
        yaml: yamlContent.trim(),
      });
    } catch (parseError) {
      res.status(400).json({
        error: 'Generated content is not valid YAML',
        raw: content
      });
    }
  } catch (error) {
    logger.error('[Skills] Generate error', { error: getErrorMessage(error) });
    res.status(500).json({ error: 'Failed to generate skill' });
  }
});

// PUT /api/v1/skills/:id - 更新 Step
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, agent, toolIds, inputs, outputs, execute, newCategory } = req.body;

    const steps = await scanAllSteps();
    const existingSkill = steps.find(s => s.id === id);

    if (!existingSkill) {
      return res.status(404).json({ success: false, error: 'Skill 不存在' });
    }

    const stepCategory = newCategory || existingSkill.category;
    const oldFilePath = getStepFilePath(existingSkill.category, id);
    const newFilePath = getStepFilePath(stepCategory, id);

    if (stepCategory !== existingSkill.category) {
      try {
        await fsPromises.access(oldFilePath);
        await ensureCategoryDir(stepCategory);
        await fsPromises.rename(oldFilePath, newFilePath);
      } catch {
        // old file doesn't exist, skip rename
      }
    }

    const result = await writeStepFile({
      id,
      name: name || existingSkill.name,
      description: description !== undefined ? description : existingSkill.description,
      category: stepCategory,
      agent: agent || existingSkill.agent,
      toolIds: toolIds || existingSkill.toolIds,
      inputs: inputs || existingSkill.inputs,
      outputs: outputs || existingSkill.outputs,
      execute: execute || existingSkill.execute,
    });

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    const step = await readStepFile(newFilePath);

    res.json({
      success: true,
      step,
      message: '步骤更新成功',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error) || '更新步骤失败',
    });
  }
});

// DELETE /api/v1/skills/:id - 删除 Step
// SEC-002: Admin only
router.delete('/:id', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const steps = await scanAllSteps();
    const existingSkill = steps.find(s => s.id === id);

    if (!existingSkill) {
      return res.status(404).json({ success: false, error: 'Skill 不存在' });
    }

    const result = await deleteStepFile(existingSkill.category, id);

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    res.json({ success: true, message: '步骤删除成功' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error) || '删除步骤失败',
    });
  }
});




export default router;
