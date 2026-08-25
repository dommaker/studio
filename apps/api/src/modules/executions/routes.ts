// Execution API 路由
// ⚠️ LEGACY surface — 仍被 web 端调用（apps/web/src/api/index.ts `executionApi` ← agentStore / ProjectDetail(Page) / PMOCard）。
// 基于 FileStore（executions.jsonl / tasks 目录 / AgentRegistry），不依赖已删除的 DB。
// 计划迁移到 agent-profiles / workunit API（见 docs/vision-2026.md），迁移前请勿在此扩展新功能。
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { FileStore, eventBus, logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import * as fs from 'fs';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { requireLocalhost } from '../../middleware/auth.js';

const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const TASKS_DIR = studioPath('data', 'tasks');
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

// 接收外部事件（来自 agent-runtime，同机进程）
// 2026-08-25 收紧：伪造 workflow.completed/failed 可篡改执行状态并向 SSE 注假数据，
// 该端点无业务上需要从公网/浏览器触达的场景，限本机回环直连。
router.post('/events', requireLocalhost(), async (req: Request, res: Response) => {
  try {
    const event = req.body;
    
    logger.info('Received runtime event', { event: JSON.stringify(event).substring(0, 100) });
    
    // 发布到 eventBus（让 TaskWorker 也能接收，无需轮询）
    eventBus.publish('events', {
      event_id: event.executionId || uuidv4(),
      event_type: event.type || event.event_type || 'runtime.event',
      timestamp: event.timestamp || new Date().toISOString(),
      data: event,
    });
    
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

export default router;
