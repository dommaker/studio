// Execution API 路由
// ⚠️ LEGACY surface — 仍被 web 端调用（apps/web/src/api/index.ts `executionApi` ← agentStore / ProjectDetail(Page) / PMOCard）。
// 基于 FileStore（executions.jsonl / tasks 目录 / AgentRegistry），不依赖已删除的 DB。
// 计划迁移到 agent-profiles / workunit API（见 docs/vision-2026.md），迁移前请勿在此扩展新功能。
import { Router, Request, Response } from 'express';
import { eventStore } from '../../core/event-store.js';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import * as path from 'path';
import { FileStore, logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const TASKS_DIR = path.join(os.homedir(), '.studio', 'data', 'tasks');
const fileStore = new FileStore();

async function findTaskByExecutionId(executionId: string): Promise<{ id: string; status: string } | null> {
  try {
    const entries = await fs.promises.readdir(TASKS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const task = await fileStore.readJson<any>(path.join(TASKS_DIR, e.name));
      if (task && task.executionId === executionId) return task;
    }
  } catch { /* dir may not exist */ }
  return null;
}

const router = Router();

interface NodeExecution {
  nodeId: string;
  status: string;
  startTime?: string;
  endTime?: string;
  output?: {
    error?: string;
    success?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// 获取执行列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const where: Record<string, unknown> = {};
    if (status) {
      where.status = status;
    }

    const allRows = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    let filtered = allRows;
    if (status) filtered = filtered.filter((e: any) => e.status === status);
    filtered.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = filtered.length;
    const executions = filtered.slice(
      (parseInt(page as string) - 1) * parseInt(limit as string),
      (parseInt(page as string) - 1) * parseInt(limit as string) + parseInt(limit as string)
    );

    // 计算每个执行的进度
    const executionsWithProgress = executions.map(exec => {
      const nodeExecutions = (exec.nodeExecutions as unknown as NodeExecution[] | null) || [];
      const totalSteps = nodeExecutions.length;
      const completedSteps = nodeExecutions.filter(n =>
        n.status === 'succeeded' || n.status === 'completed'
      ).length;
      const runningStep = nodeExecutions.findIndex(n => n.status === 'running');
      
      return {
        ...exec,
        currentStep: runningStep >= 0 ? runningStep + 1 : completedSteps,
        totalSteps,
        progress: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
      };
    });

    res.json({
      data: executionsWithProgress,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        totalPages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    logger.error('Failed to list executions', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list executions' },
    });
  }
});

// 接收外部事件（来自 agent-runtime）
router.post('/events', async (req: Request, res: Response) => {
  try {
    const event = req.body;
    
    logger.info('Received runtime event', { event: JSON.stringify(event).substring(0, 100) });
    
    // 发布到 EventStore（让 TaskWorker 也能接收，无需轮询）
    await eventStore.publish('events', JSON.stringify({
      event_id: event.executionId || uuidv4(),
      event_type: event.type || event.event_type || 'runtime.event',
      timestamp: event.timestamp || new Date().toISOString(),
      data: event,
    }));
    
    // 🆕 同步 Execution.status（根据 runtime 事件）
    // Runtime 发送的事件类型：workflow.completed, workflow.failed, workflow.started
    const eventType = event.type || event.event_type || '';
    
    if (eventType.includes('workflow.') || eventType === 'runtime.workflow.completed' || eventType === 'runtime.workflow.failed') {
      const { executionId, workflow, outputs, error } = event;
      
      // 从 executionId（runtime UUID）查找对应的 Studio Execution
      // 由于 SQLite JSON 查询限制，改用内存过滤
      const allRows = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
      const studioExecution = allRows.find((e: any) => {
        const params = (typeof e.parameters === 'string' ? JSON.parse(e.parameters) : e.parameters) || {};
        return e.status === 'running' && params.runtimeExecutionId === executionId;
      });

      if (studioExecution) {
        const newStatus = eventType.includes('completed') ? 'completed' :
                         eventType.includes('failed') ? 'failed' : 'running';

        // Update in-memory row and rewrite file
        const idx = allRows.findIndex((e: any) => e.id === studioExecution.id);
        if (idx !== -1) {
          allRows[idx] = {
            ...allRows[idx],
            status: newStatus,
            endTime: newStatus !== 'running' ? new Date().toISOString() : undefined,
            parameters: JSON.stringify({
              ...((typeof studioExecution.parameters === 'string' ? JSON.parse(studioExecution.parameters) : studioExecution.parameters) || {}),
              outputs,
              runtimeStatus: newStatus,
            }),
          };
          await fs.promises.mkdir(path.dirname(EXECUTIONS_JSONL), { recursive: true });
          await fs.promises.writeFile(EXECUTIONS_JSONL, allRows.map((r: any) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
        }
        
        logger.info(`[Execution Sync] Updated ${studioExecution.id} to ${newStatus} (runtime event: ${eventType})`);
        
        // 如果任务完成，更新 Task.status（FileStore）
        if (newStatus === 'completed' || newStatus === 'failed') {
          const task = await findTaskByExecutionId(studioExecution.id);

          if (task) {
            const fullTask = await fileStore.readJson<any>(path.join(TASKS_DIR, `${task.id}.json`));
            if (fullTask) {
              fullTask.status = newStatus === 'completed' ? 'completed' : 'failed';
              fullTask.completedAt = new Date().toISOString();
              fullTask.updatedAt = new Date().toISOString();
              await fileStore.writeJson(path.join(TASKS_DIR, `${task.id}.json`), fullTask);
            }

            logger.info(`[Task Sync] Updated task ${task.id} to ${newStatus}`);
          }
        }
      } else {
        logger.warn(`[Execution Sync] No studio execution found for runtimeExecutionId ${executionId}`);
      }
    }
    
    // Events are delivered via SSE (B0-003); WebSocket broadcast removed

    res.json({ received: true });
  } catch (error) {
    logger.error('Failed to handle event', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to handle event' },
    });
  }
});

// 获取执行详情
router.get('/:executionId', async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;

    const allExecutions = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    const execution = allExecutions.find((e: any) => e.id === executionId) || null;

    if (!execution) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Execution ${executionId} not found` },
      });
    }

    // 计算进度
    const nodeExecutions = (execution.nodeExecutions as unknown as NodeExecution[] | null) || [];
    const totalSteps = nodeExecutions.length;
    const completedSteps = nodeExecutions.filter(n =>
      n.status === 'succeeded' || n.status === 'completed'
    ).length;
    const runningStep = nodeExecutions.findIndex(n => n.status === 'running');

    const executionWithProgress = {
      ...execution,
      currentStep: runningStep >= 0 ? runningStep + 1 : completedSteps,
      totalSteps,
      progress: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
    };

    res.json(executionWithProgress);
  } catch (error) {
    logger.error('Failed to get execution', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get execution' },
    });
  }
});

// 归档任务结果到知识库
router.post('/:executionId/archive', async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const fs = await import('fs/promises');
    const path = await import('path');

    // 获取执行详情
    const allExecutions = await fileStore.readJsonl<any>(EXECUTIONS_JSONL);
    const execution = allExecutions.find((e: any) => e.id === executionId) || null;

    if (!execution) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Execution ${executionId} not found` },
      });
    }

    // 只归档已完成的任务
    if (execution.status !== 'succeeded' && execution.status !== 'completed') {
      return res.status(400).json({
        error: { code: 'NOT_COMPLETED', message: 'Only completed executions can be archived' },
      });
    }

    // 知识库路径
    const knowledgeBasePath = process.env.KNOWLEDGE_BASE_PATH || path.join(os.homedir(), 'knowledge-base');
    const tasksDir = path.join(knowledgeBasePath, 'tasks');

    // 确保目录存在
    try {
      await fs.mkdir(tasksDir, { recursive: true });
    } catch (e) {
      // 目录已存在
    }

    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '');
    const goalName = (execution.parameters as any)?.requirement || execution.id;
    const sanitizedName = goalName.replace(/[📝📋🏗️🎨⚙️🧪🚀🌐🔄👀]/g, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const fileName = `${sanitizedName || 'task'}-${timestamp.slice(0, 12)}.md`;
    const filePath = path.join(tasksDir, fileName);

    // 生成 Markdown 内容
    const nodeExecutions = (execution.nodeExecutions as unknown as NodeExecution[] | null) || [];
    const parameters = (execution.parameters as unknown as Record<string, unknown> | null) || {};

    const content = `# 任务归档: ${goalName}

> 归档时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
> 执行ID: ${executionId}
> 状态: ${execution.status}

---

## 📋 任务信息

| 项目 | 值 |
|------|-----|
| 工作流 | ${goalName} |
| 开始时间 | ${execution.startTime ? new Date(execution.startTime).toLocaleString('zh-CN') : '未开始'} |
| 结束时间 | ${execution.endTime ? new Date(execution.endTime).toLocaleString('zh-CN') : '未完成'} |
| 总步骤数 | ${nodeExecutions.length} |

---

## 📥 输入参数

\`\`\`json
${JSON.stringify(parameters, null, 2)}
\`\`\`

---

## 📤 执行结果

### 步骤执行详情

${nodeExecutions.map((node, i) => `
#### ${i + 1}. ${node.nodeId}

| 项目 | 值 |
|------|-----|
| 状态 | ${node.status} |
| 开始时间 | ${node.startTime ? new Date(node.startTime).toLocaleString('zh-CN') : '-'} |
| 结束时间 | ${node.endTime ? new Date(node.endTime).toLocaleString('zh-CN') : '-'} |

${node.output?.error ? `**错误**: ${node.output.error}` : ''}
${node.output?.success !== undefined ? `**结果**: ${node.output.success ? '✅ 成功' : '❌ 失败'}` : ''}
`).join('\n')}

---

## 💾 输出数据

\`\`\`json
${JSON.stringify(execution.error || {}, null, 2)}
\`\`\`

---

## 📁 相关文件

${((execution.error as unknown as Record<string, unknown>)?.outputFiles as string[] | undefined)?.length > 0
  ? ((execution.error as unknown as Record<string, unknown>).outputFiles as string[]).map((f: string) => `- ${f}`).join('\n')
  : '无输出文件'
}

---

*此文档由 Agent Studio 自动生成*
`;

    // 写入文件
    await fs.writeFile(filePath, content, 'utf-8');

    // 更新 INDEX.md
    const indexPath = path.join(tasksDir, 'INDEX.md');
    let indexContent = '';
    try {
      indexContent = await fs.readFile(indexPath, 'utf-8');
    } catch (e) {
      // 文件不存在，使用默认模板
      indexContent = `# 任务知识库索引

> 更新时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

---

## 统计

| 指标 | 数量 |
|------|:----:|
| 总任务数 | 1 |
| 成功 | 1 |
| 失败 | 0 |
| 成功率 | 100% |

---

## 最近任务

- [${sanitizedName || 'task'}-${timestamp.slice(0, 12)}](${fileName}) - ✅ 成功
`;
      await fs.writeFile(indexPath, indexContent, 'utf-8');
      res.json({
        success: true,
        path: filePath,
        fileName,
        message: `任务已归档到知识库: ${fileName}`,
      });
      return;
    }

    // 更新现有索引
    const status = execution.status === 'succeeded' ? '✅ 成功' : '❌ 失败';
    const newEntry = `- [${sanitizedName || 'task'}-${timestamp.slice(0, 12)}](${fileName}) - ${status}\n`;
    
    // 在 "## 最近任务" 后插入新条目
    const lines = indexContent.split('\n');
    const recentIndex = lines.findIndex(l => l.includes('## 最近任务'));
    if (recentIndex >= 0) {
      // 找到最近任务列表的结束位置
      let insertIndex = recentIndex + 1;
      while (insertIndex < lines.length && lines[insertIndex].startsWith('- [')) {
        insertIndex++;
      }
      lines.splice(recentIndex + 1, 0, newEntry.trim());
      
      // 更新统计
      const totalMatch = indexContent.match(/总任务数 \| (\d+)/);
      if (totalMatch) {
        const total = parseInt(totalMatch[1]) + 1;
        lines.forEach((line, i) => {
          if (line.includes('总任务数 |')) {
            lines[i] = line.replace(/\d+/, total.toString());
          }
        });
      }
      
      // 更新时间
      const timeLine = lines.findIndex(l => l.includes('> 更新时间:'));
      if (timeLine >= 0) {
        lines[timeLine] = `> 更新时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
      }
      
      await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
    }

    res.json({
      success: true,
      path: filePath,
      fileName,
      message: `任务已归档到知识库: ${fileName}`,
    });
  } catch (error) {
    logger.error('Failed to archive execution', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to archive execution' },
    });
  }
});

export default router;
