// builtin-tools/routes.ts — Built-in Toolset (HZ-026)
import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';

const router = Router();

interface BuiltinTool {
  name: string;
  description: string;
  category: 'file' | 'search' | 'execution' | 'communication';
  inputSchema: Record<string, any>;
  enabled: boolean;
}

const BUILTIN_TOOLS: BuiltinTool[] = [
  // File operations
  {
    name: 'read_file',
    description: '读取文件内容',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        encoding: { type: 'string', description: '编码', default: 'utf-8' },
      },
      required: ['path'],
    },
    enabled: true,
  },
  {
    name: 'write_file',
    description: '写入文件内容',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' },
        createDirs: { type: 'boolean', description: '自动创建目录', default: true },
      },
      required: ['path', 'content'],
    },
    enabled: true,
  },
  {
    name: 'list_files',
    description: '列出目录内容',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
        pattern: { type: 'string', description: 'glob 模式' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['path'],
    },
    enabled: true,
  },
  {
    name: 'edit_file',
    description: '编辑文件（查找替换）',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        oldString: { type: 'string', description: '要替换的文本' },
        newString: { type: 'string', description: '替换后的文本' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    enabled: true,
  },
  // Search
  {
    name: 'search_files',
    description: '在文件中搜索文本',
    category: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        path: { type: 'string', description: '搜索路径', default: '.' },
        pattern: { type: 'string', description: '文件名模式', default: '*' },
        maxResults: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
    enabled: true,
  },
  {
    name: 'find_files',
    description: '按名称查找文件',
    category: 'search',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名模式' },
        path: { type: 'string', description: '搜索路径', default: '.' },
      },
      required: ['pattern'],
    },
    enabled: true,
  },
  // Execution
  {
    name: 'run_command',
    description: '执行 shell 命令',
    category: 'execution',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令' },
        cwd: { type: 'string', description: '工作目录' },
        timeout: { type: 'number', description: '超时(ms)', default: 30000 },
      },
      required: ['command'],
    },
    enabled: true,
  },
  {
    name: 'run_script',
    description: '运行脚本文件',
    category: 'execution',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '脚本路径' },
        args: { type: 'array', items: { type: 'string' }, description: '参数' },
        interpreter: { type: 'string', description: '解释器', default: 'bash' },
      },
      required: ['path'],
    },
    enabled: true,
  },
  // Communication
  {
    name: 'ask_user',
    description: '向用户提问',
    category: 'communication',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题' },
        options: { type: 'array', items: { type: 'string' }, description: '选项' },
      },
      required: ['question'],
    },
    enabled: true,
  },
  {
    name: 'notify',
    description: '发送通知',
    category: 'communication',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '消息内容' },
        level: { type: 'string', enum: ['info', 'warning', 'error'], default: 'info' },
        target: { type: 'string', description: '通知目标' },
      },
      required: ['message'],
    },
    enabled: true,
  },
];

// GET /api/v1/builtin-tools — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const tools = category
      ? BUILTIN_TOOLS.filter(t => t.category === category)
      : BUILTIN_TOOLS;

    res.json({
      data: tools.map(t => ({
        name: t.name,
        description: t.description,
        category: t.category,
        inputSchema: t.inputSchema,
        enabled: t.enabled,
      })),
      total: tools.length,
      categories: [...new Set(BUILTIN_TOOLS.map(t => t.category))],
    });
  } catch (error) {
    logger.error({ error }, 'Failed to list builtin tools');
    res.status(500).json({ error: 'Failed to list builtin tools' });
  }
});

// GET /api/v1/builtin-tools/:name — 单个工具详情
router.get('/:name', async (req: Request, res: Response) => {
  try {
    const tool = BUILTIN_TOOLS.find(t => t.name === req.params.name);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    res.json(tool);
  } catch (error) {
    logger.error({ error }, 'Failed to get builtin tool');
    res.status(500).json({ error: 'Failed to get builtin tool' });
  }
});

// PATCH /api/v1/builtin-tools/:name — 启用/禁用工具
router.patch('/:name', async (req: Request, res: Response) => {
  try {
    const tool = BUILTIN_TOOLS.find(t => t.name === req.params.name);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const { enabled } = req.body;
    if (typeof enabled === 'boolean') {
      tool.enabled = enabled;
    }

    logger.info({ tool: tool.name, enabled: tool.enabled }, 'Builtin tool updated');
    res.json(tool);
  } catch (error) {
    logger.error({ error }, 'Failed to update builtin tool');
    res.status(500).json({ error: 'Failed to update builtin tool' });
  }
});

export default router;
