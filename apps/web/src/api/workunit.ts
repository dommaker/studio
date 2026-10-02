// WorkUnit API — Agent Network §3.28c-1
// 类型正本 = @dommaker/studio-contract workunit 域（zod schema z.infer）；
// 本文件只保留事件负载（/events + SSE，非 workunit REST）的解析器与本地类型。
import { api } from './index';
import type {
  WorkUnit,
  PaginatedBody,
  DataBody,
  CreateWorkUnitBody,
  UpdateWorkUnitBody,
  ReviewConfirmPayload,
  PlanRulingPayload,
  PlanDirectionPayload,
  TreeTokenReport,
  VerifyResult,
  DispatchReviewResult,
  DiscussionMessage,
  DiscussionMessagesResult,
  LastDoneResult,
  ChangedFilesResult,
  AdoptOpportunityResult,
  IgnoreOpportunityResult,
} from '@dommaker/studio-contract';

// 契约类型再出口（消费方继续从本模块 import，不感知包边界迁移）
export type {
  WorkUnit,
  ReviewConfirmPayload,
  PlanRulingPayload,
  PlanDirectionPayload,
  TreeTokenReport,
  VerifyResult,
  DispatchReviewResult,
  DiscussionMessage,
  DiscussionMessagesResult,
  AdoptOpportunityResult,
  IgnoreOpportunityResult,
} from '@dommaker/studio-contract';
/** 巡检机会条目（契约名 InspectionOpportunity；UI 侧沿用短名 Opportunity） */
export type { InspectionOpportunity as Opportunity } from '@dommaker/studio-contract';
/** 分页壳别名 = 契约 PaginatedBody（后端 formatPaginatedResponse 同形状） */
export type PaginatedResponse<T> = PaginatedBody<T>;

// 事件负载类型（WorkunitTokenEvent/ExecutionStepToolCall/ExecutionStepEvent/ExecutionStreamChunk）
// P3-a 迁至 src/types/workunit.ts（api 层不声明导出类型），此处仅 re-export，消费方 import 路径不变。
import type { WorkunitTokenEvent, ExecutionStepToolCall, ExecutionStepEvent, ExecutionStreamChunk } from '../types/workunit';
export type { WorkunitTokenEvent, ExecutionStepToolCall, ExecutionStepEvent, ExecutionStreamChunk };

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
        status: p.status === 'failed' ? 'failed' : 'success',
        errorType: typeof p.errorType === 'string' ? p.errorType : undefined,
        errorDetail: typeof p.errorDetail === 'string' ? p.errorDetail : undefined,
        thinking: Array.isArray(p.thinking) ? p.thinking.filter((t: unknown) => typeof t === 'string') : [],
        toolCalls: Array.isArray(p.toolCalls)
          ? p.toolCalls
              .filter((c: unknown): c is { tool: string; summary?: unknown } =>
                !!c && typeof (c as { tool?: unknown }).tool === 'string')
              .map((c) => ({ tool: c.tool, summary: typeof c.summary === 'string' ? c.summary : '' }))
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


/**
 * 解析 SSE 信封 data → ExecutionStreamChunk（损坏/缺关键字段 → null，跳过不编造）。
 */
export function parseExecutionStreamChunk(data: unknown): ExecutionStreamChunk | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.workUnitId !== 'string' || typeof p.step !== 'number') return null;
    if (!['step-start', 'thinking', 'text', 'tool', 'tool-result', 'result'].includes(String(p.kind))) return null;
    return {
      workUnitId: p.workUnitId,
      executionId: typeof p.executionId === 'string' ? p.executionId : '',
      step: p.step,
      kind: p.kind as ExecutionStreamChunk['kind'],
      text: typeof p.text === 'string' ? p.text : undefined,
      tool: typeof p.tool === 'string' ? p.tool : undefined,
      summary: typeof p.summary === 'string' ? p.summary : undefined,
      toolUseId: typeof p.toolUseId === 'string' ? p.toolUseId : undefined,
      isError: p.isError === true ? true : undefined,
      at: typeof p.at === 'string' ? p.at : '',
    };
  } catch {
    return null;
  }
}

/** 文本截断（超长追加省略号） */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * ExecutionStreamChunk → 面向人读的一行动态文案（chunk→text 映射全站唯一出处）。
 * - tool → `🔧 工具 摘要`；thinking → `思考：…`；text → 原文；result → `✓/✗ …`；step-start → null（不产出文案）
 * - 默认截断（summary/thinking 40、text 60）；对应项传 false 不截断（ExecutionSteps 完整展示）
 * 消费方：useAgentRoster（角色卡「最近动态」）、ExecutionSteps（Layer B 实时区）
 */
export function formatExecutionStreamChunkText(
  chunk: ExecutionStreamChunk,
  opts: { maxTextLength?: number | false; maxSummaryLength?: number | false } = {},
): string | null {
  const maxText = opts.maxTextLength === undefined ? 60 : opts.maxTextLength;
  const maxSummary = opts.maxSummaryLength === undefined ? 40 : opts.maxSummaryLength;
  const cut = (s: string, max: number | false) => (max === false ? s : truncateText(s, max));
  switch (chunk.kind) {
    case 'tool':
      return chunk.tool ? `🔧 ${chunk.tool}${chunk.summary ? ` ${cut(chunk.summary, maxSummary)}` : ''}` : null;
    case 'thinking':
      return chunk.text ? `思考：${cut(chunk.text, maxSummary)}` : null;
    case 'text':
      return chunk.text ? cut(chunk.text, maxText) : null;
    case 'result':
      return `${chunk.isError ? '✗' : '✓'} ${cut(chunk.text || '回合结束', maxText)}`;
    default:
      return null;
  }
}

// 响应壳：全部端点已统一 envelope——单实体 `{ data: T }`（DataBody），列表 `{ data, pagination }`（PaginatedBody）。
export const workunitApi = {
  list: (params?: {
    type?: string;
    status?: string;
    assigneeId?: string;
    channelId?: string;
    /** #405：归属维度服务端过滤（#428 API）；false = 未归属（无 reqId 且归因戳为 null） */
    attributed?: boolean;
    /** #456：PMO 项目归属服务端过滤（reqId 绑定优先 → pmoId 戳兜底，与 PMO 台账同口径） */
    projectId?: string;
    /** 批次 D-2 项4：标题（scope）大小写不敏感子串搜索 */
    q?: string;
    page?: number;
    limit?: number;
  }) => api.get<PaginatedBody<WorkUnit>>('/workunits', { params }),

  get: (id: string) => api.get<DataBody<WorkUnit>>(`/workunits/${id}`),

  /** #387 批量聚合：每 assignee 最近一条完成 WU（roster 空闲卡「最近完成」，替代逐实例 list 的 N+1） */
  lastDone: (assigneeIds: string[]) =>
    api.get<DataBody<LastDoneResult>>(
      '/workunits/last-done',
      { params: { assigneeIds: assigneeIds.join(',') } },
    ),

  create: (data: CreateWorkUnitBody) => api.post<DataBody<WorkUnit>>('/workunits', data),

  update: (id: string, data: UpdateWorkUnitBody) =>
    api.put<DataBody<WorkUnit>>(`/workunits/${id}`, data),

  delete: (id: string) => api.delete(`/workunits/${id}`),

  /** #445：agentId 可省略——缺省由服务端按会话用户解析（人工引导片认领，身份诚实归因） */
  claim: (id: string, agentId?: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/claim`, agentId ? { agentId } : {}),

  unclaim: (id: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/unclaim`),

  transitionStatus: (id: string, status: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/status`, { status }),

  // #106 M7：可选 summary 穿透 l3 台账（analysis 确认弹窗的待决问题清单、decision 结论等）
  // #177：可选 defaultAssigneeId（analysis 确认处「默认执行角色」）→ 应用于全部派生 task 子 WU
  // #463：可选 confirm 结构化评审表单（decision/spec/analysis）——后端序列化为 l3.summary，
  // 存储契约不变；与 summary 并存时 confirm 优先（人永远不接触魔法行）
  reviewPassed: (id: string, summary?: string, defaultAssigneeId?: string, confirm?: ReviewConfirmPayload) => {
    const trimmed = summary?.trim();
    return api.post<DataBody<WorkUnit>>(`/workunits/${id}/review-passed`, {
      ...(trimmed ? { summary: trimmed } : {}),
      ...(defaultAssigneeId ? { defaultAssigneeId } : {}),
      ...(confirm ? { confirm } : {}),
    });
  },

  reviewRejected: (id: string, reason?: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/review-rejected`, { reason }),

  /** F6-c: 人工重跑 L1 自动验证（human-only，只动台账不动状态） */
  verify: (id: string, commands?: string[]) =>
    api.post<DataBody<VerifyResult>>(`/workunits/${id}/verify`, commands ? { commands } : {}),

  /** F6-c: 人工补派 L2 agent 评审（human-only） */
  dispatchReview: (id: string) =>
    api.post<DataBody<DispatchReviewResult>>(`/workunits/${id}/dispatch-review`),

  /** #185（决策 #87 D2）：Web 按钮通道「继续执行」——纯授权复活，与频道回复共享同一复活原语 */
  resume: (id: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/resume`),

  /** #185（决策 #87 D2）：Web 按钮通道「关闭任务」——死信显式关闭路径（decision/spec 无 closed → 409） */
  close: (id: string) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/close`),

  /** #467：裁决轮一次性提交（全对/单题修改/打回重议）——后端批量落探路台账并复活同会话 */
  submitRuling: (id: string, payload: PlanRulingPayload) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/ruling`, payload),

  /** #567：方向锁定选定提交——后端落探路台账并复活同会话（裁决轮前置环节） */
  submitDirection: (id: string, payload: PlanDirectionPayload) =>
    api.post<DataBody<WorkUnit>>(`/workunits/${id}/direction`, payload),

  getMessages: (id: string, params?: { before?: string; limit?: number }) =>
    api.get<DataBody<DiscussionMessagesResult>>(`/workunits/${id}/messages`, { params }),

  postMessage: (id: string, content: string, authorType?: 'human' | 'agent') =>
    api.post<DataBody<DiscussionMessage>>(`/workunits/${id}/messages`, { content, authorType }),

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
    api.get<DataBody<TreeTokenReport>>(`/workunits/${id}/tree-tokens`),

  /** 批量版（2026-09-25 频道首屏合并）：一次请求拿全部 WU 文件集，缺键/空数组 → 降级候选集词表 */
  getChangedFilesBatch: (ids: string[]) =>
    api.get<DataBody<ChangedFilesResult>>(
      '/workunits/changed-files',
      { params: { ids: ids.join(',') } },
    ),

  /** #163 T8-E2: 巡检机会采纳（201，建 feature 子单，源条目记 wuId） */
  adoptOpportunity: (id: string, oppId: string) =>
    api.post<DataBody<AdoptOpportunityResult>>(`/workunits/${id}/opportunities/${oppId}/adopt`),

  /** #163 T8-E2: 巡检机会忽略（200，终态；reason 可省） */
  ignoreOpportunity: (id: string, oppId: string, reason?: string) =>
    api.post<DataBody<IgnoreOpportunityResult>>(`/workunits/${id}/opportunities/${oppId}/ignore`, { reason }),
};
