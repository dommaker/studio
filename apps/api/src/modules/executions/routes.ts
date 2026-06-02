// Execution API 路由
import { Router, Request, Response } from 'express';
import { prisma } from '../../core/database.js';
import { eventStore } from '../../core/event-store.js';
import { logger } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import * as path from 'path';

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
    const { workflowId, status, page = 1, limit = 20 } = req.query;

    const where: Record<string, unknown> = {};
    if (workflowId) {
      where.workflowId = workflowId;
    }
    if (status) {
      where.status = status;
    }

    const [executions, total] = await Promise.all([
      prisma.execution.findMany({
        where,
        skip: (parseInt(page as string) - 1) * parseInt(limit as string),
        take: parseInt(limit as string),
        orderBy: { createdAt: 'desc' },
        include: {}
      }),
      prisma.execution.count({ where }),
    ]);

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
        goalName: (exec as any).Goal?.name,
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
      const allExecutions = await prisma.execution.findMany({
        where: { status: 'running' },
        select: { id: true, parameters: true },
      });
      
      const studioExecution = allExecutions.find(e => {
        const params = e.parameters as unknown as Record<string, unknown> | null;
        return params?.runtimeExecutionId === executionId;
      });
      
      if (studioExecution) {
        const newStatus = eventType.includes('completed') ? 'completed' : 
                         eventType.includes('failed') ? 'failed' : 'running';
        
        const updated = await prisma.execution.update({
          where: { id: studioExecution.id },
          data: {
            status: newStatus,
            endTime: newStatus !== 'running' ? new Date() : undefined,
            error: error ? { message: error } as any : undefined,
            parameters: {
              ...((studioExecution.parameters as unknown as Record<string, unknown>) || {}),
              outputs,
              runtimeStatus: newStatus,
            } as any,
          },
        });
        
        logger.info(`[Execution Sync] Updated ${studioExecution.id} to ${newStatus} (runtime event: ${eventType})`);
        
        // 🆕 如果任务完成，更新 Task.status
        if (newStatus === 'completed' || newStatus === 'failed') {
          const task = await prisma.task.findFirst({
            where: { executionId: studioExecution.id },
          });

          if (task) {
            await prisma.task.update({
              where: { id: task.id },
              data: {
                status: newStatus === 'completed' ? 'completed' : 'failed',
                completedAt: new Date(),
              },
            });

            logger.info(`[Task Sync] Updated task ${task.id} to ${newStatus}`);

            // 非 Goal 路径的旧流程已废弃：Project 状态由 GoalScheduler → agent-event-listener 处理
            if (newStatus === 'completed') {
              const goalExecId = (studioExecution.parameters as unknown as Record<string, unknown>)?.goalExecutionId as string | undefined;
              if (!goalExecId) {
                logger.info('[Legacy] Task completed without Goal, skipping Project status update (deprecated path)');
              }
            }
          }

          // 更新 GoalExecution 状态（如果有关联）
          const goalExecId = (studioExecution.parameters as unknown as Record<string, unknown>)?.goalExecutionId as string | undefined;
          if (goalExecId) {
            try {
              const { goalService } = await import('../goals/goal.service.js');
              await goalService.updateStepExecution(goalExecId, {
                status: newStatus === 'completed' ? 'succeeded' : 'failed',
                output: outputs,
                error: error ? String(error) : undefined,
              });
              logger.info(`[GoalExecution Sync] Updated ${goalExecId} to ${newStatus === 'completed' ? 'succeeded' : 'failed'}`);
            } catch (goalErr) {
              logger.error('[GoalExecution Sync] Failed to update', { error: String(goalErr) });
            }
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

    const execution = await (prisma.execution.findUnique as Function)({
      where: { id: executionId },
      include: {
        Goal: {
          select: { name: true }
        }
      }
    });

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
      goalName: (execution as any).Goal?.name,
    };

    res.json(executionWithProgress);
  } catch (error) {
    logger.error('Failed to get execution', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get execution' },
    });
  }
});

// 获取 Worker 状态
router.get('/worker/status', async (req: Request, res: Response) => {
  try {
    const { taskWorker } = await import('@dommaker/studio-task');
    const status = taskWorker.getStatus();
    res.json({
      ...status,
      executor: 'typescript',
    });
  } catch (error) {
    logger.error('Failed to get worker status', { error: String(error) });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get worker status' },
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
    const execution = await (prisma.execution.findUnique as Function)({
      where: { id: executionId },
      include: {
        Goal: {
          select: { name: true }
        }
      }
    });

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
    const goalName = (execution as any).Goal?.name || execution.workflowId || "";
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
