// Execution API 路由
// ⚠️ LEGACY surface — 前端消费方已不存在（2026-09 grep 实证 apps/web 无 /api/v1/executions 调用，
// 原注释声称的 executionApi/agentStore/ProjectDetail 已退役）。
// 基于 FileStore（executions.jsonl / tasks 目录 / AgentRegistry），不依赖已删除的 DB。
// 计划迁移到 agent-profiles / workunit API（见 docs/vision-2026.md），迁移前请勿在此扩展新功能。
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { eventBus, logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import {
  executionListQuerySchema,
  executionDetailParamsSchema,
  executionEventBodySchema,
} from '@dommaker/studio-contract';
import { defineRoute, HttpError, paginated } from '../../core/http.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { requireLocalhost } from '../../middleware/auth.js';
import { getStore } from '../../core/store.js';


const EXECUTIONS_JSONL = resolveStudioLogFile('executions.jsonl');
const TASKS_DIR = studioPath('data', 'tasks');

async function findTaskByExecutionId(executionId: string): Promise<{ id: string; status: string } | null> {
  // P2-e：目录清单走 FileStore listJsonInDir seam（dirCache + 读穿缓存），ENOENT → [] 语义不变
  const tasks = await getStore().listJsonInDir<any>(TASKS_DIR);
  return tasks.find(t => t && t.executionId === executionId) ?? null;
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

/** 进度三键派生（nodeExecutions → currentStep/totalSteps/progress），列表与详情共用 */
function withProgress<T extends Record<string, unknown>>(exec: T) {
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
}

// 获取执行列表
router.get('/', defineRoute({ query: executionListQuerySchema }, async (_req, _res, { query }) => {
  const { status, page = '1', limit = '20' } = query;

  const allRows = await getStore().readJsonl<any>(EXECUTIONS_JSONL);
  let filtered = allRows;
  if (status) filtered = filtered.filter((e: any) => e.status === status);
  filtered.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = filtered.length;
  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const executions = filtered.slice((pageNum - 1) * limitNum, (pageNum - 1) * limitNum + limitNum);

  return paginated(executions.map(withProgress), {
    page: pageNum,
    limit: limitNum,
    total,
    totalPages: Math.ceil(total / limitNum),
  });
}));

// 接收外部事件（来自 agent-runtime，同机进程）
// 2026-08-25 收紧：伪造 workflow.completed/failed 可篡改执行状态并向 SSE 注假数据，
// 该端点无业务上需要从公网/浏览器触达的场景，限本机回环直连。
router.post('/events', requireLocalhost(), defineRoute({ body: executionEventBodySchema }, async (_req, _res, { body: event }) => {
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
      const allRows = await getStore().readJsonl<any>(EXECUTIONS_JSONL);
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
          // P2-e：全量重写走 FileStore writeJsonl（原子写：tmp+rename），替代裸 fs.writeFile
          await getStore().writeJsonl(EXECUTIONS_JSONL, allRows);
        }
        
        logger.info(`[Execution Sync] Updated ${studioExecution.id} to ${newStatus} (runtime event: ${eventType})`);
        
        // 如果任务完成，更新 Task.status（FileStore）
        if (newStatus === 'completed' || newStatus === 'failed') {
          const task = await findTaskByExecutionId(studioExecution.id);

          if (task) {
            const fullTask = await getStore().readJson<any>(path.join(TASKS_DIR, `${task.id}.json`));
            if (fullTask) {
              fullTask.status = newStatus === 'completed' ? 'completed' : 'failed';
              fullTask.completedAt = new Date().toISOString();
              fullTask.updatedAt = new Date().toISOString();
              await getStore().writeJson(path.join(TASKS_DIR, `${task.id}.json`), fullTask);
            }

            logger.info(`[Task Sync] Updated task ${task.id} to ${newStatus}`);
          }
        }
      } else {
        logger.warn(`[Execution Sync] No studio execution found for runtimeExecutionId ${executionId}`);
      }
    }
    
    // Events are delivered via SSE (B0-003); WebSocket broadcast removed

    return { received: true };
}));

// 获取执行详情
router.get('/:executionId', defineRoute({ params: executionDetailParamsSchema }, async (_req, _res, { params }) => {
  const allExecutions = await getStore().readJsonl<any>(EXECUTIONS_JSONL);
  const execution = allExecutions.find((e: any) => e.id === params.executionId) || null;

  if (!execution) {
    throw new HttpError(404, 'NOT_FOUND', `Execution ${params.executionId} not found`);
  }

  return withProgress(execution);
}));

export default router;
