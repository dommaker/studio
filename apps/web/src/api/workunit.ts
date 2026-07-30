// WorkUnit API — Agent Network §3.28c-1
import { api } from './index';

export interface WorkUnit {
  id: string;
  parentId: string | null;
  dependsOn: string;
  type: string;
  scope: string;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: string | null;
  channelId: string | null;
  reqId?: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** M2 成本红线度量：agent-loop 写入的 workunit:tokens 事件（payload 解析后） */
export interface WorkunitTokenEvent {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（chars/4 约定） */
  injectedTokens: number;
  /** 执行总 tokens；CLI 未回报 usage 时为 null（不编造 0） */
  executionTokens: number | null;
  executionSource?: string;
  totalTokens: number;
  createdAt?: string;
}

/**
 * 从 GET /events?type=workunit:tokens 的响应行中解析某个 WorkUnit 的 token 事件。
 * payload 损坏或不属于该 WorkUnit 的行跳过（不计 0，不编造）。
 */
export function parseWorkunitTokenEvents(
  rows: Array<{ payload: unknown; createdAt?: string }>,
  workUnitId: string,
): WorkunitTokenEvent[] {
  const out: WorkunitTokenEvent[] = [];
  for (const row of rows) {
    try {
      const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (!p || p.workUnitId !== workUnitId) continue;
      if (typeof p.injectedTokens !== 'number') continue;
      out.push({
        workUnitId: p.workUnitId,
        executionId: p.executionId,
        injectedTokens: p.injectedTokens,
        executionTokens: typeof p.executionTokens === 'number' ? p.executionTokens : null,
        executionSource: p.executionSource,
        totalTokens: typeof p.totalTokens === 'number' ? p.totalTokens : p.injectedTokens,
        createdAt: row.createdAt,
      });
    } catch {
      // 跳过损坏行
    }
  }
  return out;
}

/** WU 过程可视化：agent-loop 每步执行结束写入的 workunit:execution_step 事件（payload 解析后） */
export interface ExecutionStepToolCall {
  tool: string;
  /** 面向人读的输入摘要（file_path / command / pattern…，已截断） */
  summary: string;
}

export interface ExecutionStepEvent {
  workUnitId: string;
  executionId: string;
  sessionId?: string;
  /** 1 基步号 */
  step: number;
  action?: string;
  /** 模型思考摘要（≤3 条，已截断） */
  thinking: string[];
  /** 本步工具调用（≤30 条） */
  toolCalls: ExecutionStepToolCall[];
  /** 本步注入的 skill 名单 */
  skills: string[];
  text?: string;
  usage?: { inputTokens: number; outputTokens: number; model?: string };
  at: string;
}

/**
 * 从 GET /events?type=workunit:execution_step 的响应行解析执行步事件。
 * 兼容历史无 workUnitId 过滤的调用方：传 workUnitId 时顺带按它过滤；
 * 损坏行/缺 step 的行跳过；按 step → at 升序（回放顺序）。
 */
export function parseExecutionStepEvents(
  rows: Array<{ payload: unknown; createdAt?: string }>,
  workUnitId?: string,
): ExecutionStepEvent[] {
  const out: ExecutionStepEvent[] = [];
  for (const row of rows) {
    try {
      const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (!p || typeof p.step !== 'number') continue;
      if (workUnitId && p.workUnitId !== workUnitId) continue;
      out.push({
        workUnitId: p.workUnitId,
        executionId: p.executionId ?? '',
        sessionId: p.sessionId,
        step: p.step,
        action: typeof p.action === 'string' ? p.action : undefined,
        thinking: Array.isArray(p.thinking) ? p.thinking.filter((t: unknown) => typeof t === 'string') : [],
        toolCalls: Array.isArray(p.toolCalls)
          ? p.toolCalls.filter((c: any) => c && typeof c.tool === 'string').map((c: any) => ({ tool: c.tool, summary: typeof c.summary === 'string' ? c.summary : '' }))
          : [],
        skills: Array.isArray(p.skills) ? p.skills.filter((s: unknown) => typeof s === 'string') : [],
        text: typeof p.text === 'string' ? p.text : undefined,
        usage: p.usage && typeof p.usage.inputTokens === 'number' ? p.usage : undefined,
        at: typeof p.at === 'string' ? p.at : (row.createdAt ?? ''),
      });
    } catch {
      // 跳过损坏行
    }
  }
  out.sort((a, b) => a.step - b.step || a.at.localeCompare(b.at));
  return out;
}


/** Layer B 步内流式 chunk（SSE `workunit.execution.stream`，SSE-only 无 REST 回放——落盘归档是 execution_step 的事） */
export interface ExecutionStreamChunk {
  workUnitId: string;
  executionId: string;
  step: number;
  kind: 'step-start' | 'thinking' | 'text' | 'tool' | 'result';
  text?: string;
  tool?: string;
  summary?: string;
  isError?: boolean;
  at: string;
}

/**
 * 解析 SSE 信封 data → ExecutionStreamChunk（损坏/缺关键字段 → null，跳过不编造）。
 */
export function parseExecutionStreamChunk(data: unknown): ExecutionStreamChunk | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.workUnitId !== 'string' || typeof p.step !== 'number') return null;
    if (!['step-start', 'thinking', 'text', 'tool', 'result'].includes(String(p.kind))) return null;
    return {
      workUnitId: p.workUnitId,
      executionId: typeof p.executionId === 'string' ? p.executionId : '',
      step: p.step,
      kind: p.kind as ExecutionStreamChunk['kind'],
      text: typeof p.text === 'string' ? p.text : undefined,
      tool: typeof p.tool === 'string' ? p.tool : undefined,
      summary: typeof p.summary === 'string' ? p.summary : undefined,
      isError: p.isError === true ? true : undefined,
      at: typeof p.at === 'string' ? p.at : '',
    };
  } catch {
    return null;
  }
}


export const workunitApi = {
  list: (params?: {
    type?: string;
    status?: string;
    assigneeId?: string;
    channelId?: string;
    page?: number;
    limit?: number;
  }) => api.get<PaginatedResponse<WorkUnit>>('/workunits', { params }),

  get: (id: string) => api.get<WorkUnit>(`/workunits/${id}`),

  create: (data: {
    scope: string;
    type?: string;
    assigneeId?: string;
    status?: string;
    channelId?: string;
    parentId?: string;
    dependsOn?: string;
    metadata?: string;
  }) => api.post<WorkUnit>('/workunits', data),

  update: (id: string, data: Partial<WorkUnit>) =>
    api.put<WorkUnit>(`/workunits/${id}`, data),

  delete: (id: string) => api.delete(`/workunits/${id}`),

  claim: (id: string, agentId: string) =>
    api.post<WorkUnit>(`/workunits/${id}/claim`, { agentId }),

  unclaim: (id: string) =>
    api.post<WorkUnit>(`/workunits/${id}/unclaim`),

  transitionStatus: (id: string, status: string) =>
    api.post<WorkUnit>(`/workunits/${id}/status`, { status }),

  reviewPassed: (id: string) =>
    api.post<WorkUnit>(`/workunits/${id}/review-passed`),

  reviewRejected: (id: string, reason?: string) =>
    api.post<WorkUnit>(`/workunits/${id}/review-rejected`, { reason }),

  /** F6-c: 人工重跑 L1 自动验证（human-only，只动台账不动状态） */
  verify: (id: string, commands?: string[]) =>
    api.post<VerifyResult>(`/workunits/${id}/verify`, commands ? { commands } : {}),

  /** F6-c: 人工补派 L2 agent 评审（human-only） */
  dispatchReview: (id: string) =>
    api.post<DispatchReviewResult>(`/workunits/${id}/dispatch-review`),

  getMessages: (id: string, params?: { before?: string; limit?: number }) =>
    api.get(`/workunits/${id}/messages`, { params }),

  postMessage: (id: string, content: string, authorType?: 'human' | 'agent') =>
    api.post(`/workunits/${id}/messages`, { content, authorType }),

  /** M2: workunit:tokens 度量事件（配合 parseWorkunitTokenEvents 按 WorkUnit 过滤） */
  listTokenEvents: (limit = 200) =>
    api.get<{ events: Array<{ payload: unknown; createdAt?: string }>; total: number }>(
      '/events',
      { params: { type: 'workunit:tokens', limit } },
    ),

  /** WU 过程可视化：执行步事件（思考/工具/skill/用量，服务端按 workUnitId 过滤） */
  listExecutionStepEvents: (workUnitId: string, limit = 100) =>
    api.get<{ events: Array<{ payload: unknown; createdAt?: string }>; total: number }>(
      '/events',
      { params: { type: 'workunit:execution_step', workUnitId, limit } },
    ),

  /** AC-5.4: 树级 token 开销聚合 */
  getTreeTokens: (id: string) =>
    api.get<TreeTokenReport>(`/workunits/${id}/tree-tokens`),
};

/** AC-5.4: 树级 token 开销报告（GET /workunits/:id/tree-tokens 响应体） */
export interface TreeTokenReport {
  rootId: string;
  nodes: Array<{
    workUnitId: string;
    profileName: string | null;
    status: string;
    injectedTokens: number | null;
    executionTokens: number | null;
    totalTokens: number | null;
  }>;
  rootTotal: number;
  budgetRemaining: number;
}

/** F6-c: POST /workunits/:id/verify 响应体（200；400/409 走 error 信封，422 为 {verified:false, reason, hint}） */
export interface VerifyResult {
  verified: boolean;
  /** 验证通过时的报告（metadata.verifyReport 或 {commands, source}） */
  report?: unknown;
  /** 验证失败时的失败命令与输出尾巴 */
  failed?: Array<{ command: string; tail: string }>;
  /** 422 no-commands 时的原因与提示 */
  reason?: string;
  hint?: string;
}

/** F6-c: POST /workunits/:id/dispatch-review 响应体 */
export interface DispatchReviewResult {
  reviewWorkUnitId: string;
}
