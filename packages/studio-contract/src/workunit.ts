/**
 * workunit 域契约（首个迁移域，30+ 域的模板）——正本字段以
 * apps/api/src/modules/workunit/workunit-crud.ts（WorkUnitData）与路由实际 wire 行为为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 单实体/对象端点：`{ data: T }`（create/get/update/claim/review/resume/close/ruling/
 *   direction/verify/dispatch-review/tree-tokens/last-done/changed-files/messages 写/opportunities）
 * - 列表：`{ data: T[], pagination }`（GET /，本就分页壳，未变）
 * - 讨论区列表：`{ data: { messages, total, hasMore } }`（cursor 分页，非 page/limit 壳）
 * - DELETE：204 无体
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── 实体 ──

export const assignmentSummarySchema = z.object({
  id: z.string(),
  workUnitId: z.string(),
  attempt: z.number().int().positive(),
  previousAssignmentId: z.string().nullable(),
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'superseded', 'cancelled']),
  reason: z.enum(['claim', 'retry', 'recovery', 'need-input-reply', 'session-replacement']),
  provider: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  waitingAt: z.string().optional(),
  endedAt: z.string().optional(),
  lastError: z.string().optional(),
  tokenCount: z.number(),
  transcriptCount: z.number(),
  progressCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
});

export const workUnitExecutionSchema = z.object({
  current: assignmentSummarySchema.nullable(),
  assignments: z.array(assignmentSummarySchema),
  totals: z.object({
    tokenCount: z.number(),
    transcriptCount: z.number().int().nonnegative(),
    progressCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
  }),
});

const mandatePrincipalSchema = z.object({
  id: z.string(),
  type: z.enum(['Operator', 'System']),
});

/** #706：additive 长期授权只读事实；不接受客户端直接写入。 */
export const mandateSchema = z.object({
  workUnitId: z.string(),
  revision: z.number().int().positive(),
  policyVersion: z.literal('1'),
  requestedBy: mandatePrincipalSchema,
  grantedBy: mandatePrincipalSchema,
  grantedAt: z.string(),
  source: z.object({
    kind: z.enum(['channel', 'api', 'derived', 'system']),
    channelId: z.string().optional(),
    messageId: z.string().optional(),
    parentWorkUnitId: z.string().optional(),
  }),
  reqId: z.string().nullable(),
  pmoId: z.string().nullable(),
  repositories: z.array(z.object({ repo: z.string(), leg: z.string().nullable() })),
  deliveryActions: z.array(z.enum(['merge', 'deliver', 'mark-delivered'])),
  budget: z.object({ tokens: z.number().nullable(), planSteps: z.number().nullable() }),
  expansionPrincipals: z.array(mandatePrincipalSchema),
  history: z.array(z.object({
    revision: z.number().int().positive(),
    action: z.enum(['issued', 'expanded', 'reauthorized', 'revoked']),
    actor: mandatePrincipalSchema,
    at: z.string(),
    reason: z.string().optional(),
  })),
  revokedAt: z.string().optional(),
  revokedBy: mandatePrincipalSchema.optional(),
  revokeReason: z.string().optional(),
});

/** #707：additive 持久副作用只读投影；客户端没有 Effect 写口。 */
export const effectRecordSchema = z.object({
  id: z.string(),
  workUnitId: z.string(),
  kind: z.literal('review-dispatch'),
  idempotencyKey: z.string(),
  trigger: z.enum(['automatic', 'manual']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_reconciliation']),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextAttemptAt: z.string().optional(),
  startedAt: z.string().optional(),
  lastError: z.string().optional(),
});

export const effectReceiptSchema = z.object({
  id: z.string(),
  effectId: z.string(),
  idempotencyKey: z.string(),
  outcome: z.enum(['succeeded', 'retrying', 'failed', 'cancelled']),
  at: z.string(),
  attempts: z.number().int().nonnegative(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  recovery: z.enum(['queued-restarted', 'running-reconciled', 'revocation']).optional(),
});

/**
 * WorkUnit wire 形状（JSON 序列化后的 WorkUnitData：Date → ISO string）。
 * 字段正本 = apps/api workunit-crud.ts snapshotToData；dependsOn 不存在于后端（前端手抄版的漂移字段）。
 */
export const workUnitSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  type: z.string(),
  scope: z.string(),
  assigneeId: z.string().nullable(),
  status: z.string(),
  failureType: z.string().nullable(),
  retryCount: z.number(),
  timeoutAt: z.string().nullable(),
  channelId: z.string().nullable(),
  projectPath: z.string().nullable(),
  workspaceId: z.string().nullable().optional(),
  reqId: z.string().nullable().optional(),
  assigneeRoleId: z.string().nullable().optional(),
  metadata: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** #706：additive 长期授权只读事实；旧 WU 可缺省。 */
  mandate: mandateSchema.optional(),
  /** #705：additive 执行轮次只读摘要；旧 WU 可缺省。 */
  execution: workUnitExecutionSchema.optional(),
  /** #707：additive Effect/Receipt 只读投影；旧 WU 可缺省。 */
  effects: z.array(effectRecordSchema).optional(),
  effectReceipts: z.array(effectReceiptSchema).optional(),
  /** #109：仅列表项与事件负载附带的「可认领」标记 */
  claimable: z.boolean().optional(),
});
export type WorkUnit = z.infer<typeof workUnitSchema>;

/** #163 巡检机会条目（WU metadata.opportunities 数组元素；adopt/ignore 响应内嵌） */
export const inspectionOpportunitySchema = z.object({
  id: z.string(),
  problem: z.string(),
  suggestion: z.string(),
  estimate: z.string().optional(),
  status: z.enum(['pending', 'adopted', 'ignored']),
  wuId: z.string().optional(),
  ignoreReason: z.string().optional(),
});
export type InspectionOpportunity = z.infer<typeof inspectionOpportunitySchema>;

/** AC-5.4：GET /:id/tree-tokens 的树级 token 开销报告 */
export const treeTokenReportSchema = z.object({
  rootId: z.string(),
  nodes: z.array(z.object({
    workUnitId: z.string(),
    profileName: z.string().nullable(),
    status: z.string(),
    injectedTokens: z.number().nullable(),
    executionTokens: z.number().nullable(),
    totalTokens: z.number().nullable(),
  })),
  rootTotal: z.number(),
  budgetRemaining: z.number(),
});
export type TreeTokenReport = z.infer<typeof treeTokenReportSchema>;

/** 讨论区消息 wire 形状（studio-shared ChannelMessageData；meta 为 JSON 字符串） */
export const discussionMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  workUnitId: z.string().nullable(),
  authorType: z.string(),
  agentName: z.string().nullable(),
  content: z.string(),
  replyToId: z.string().nullable(),
  meta: z.string(),
  createdAt: z.string(),
});
export type DiscussionMessage = z.infer<typeof discussionMessageSchema>;

// ── 请求：query / params ──

/** GET / 列表过滤（全字符串宽松透传；attributed 非法值/空白 q 由 handler 归一为不过滤，保持旧行为） */
export const listWorkUnitsQuerySchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  assigneeId: z.string().optional(),
  channelId: z.string().optional(),
  parentId: z.string().optional(),
  attributed: z.string().optional(),
  projectId: z.string().optional(),
  q: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type ListWorkUnitsQuery = z.infer<typeof listWorkUnitsQuerySchema>;

export const lastDoneQuerySchema = z.object({
  /** 逗号分隔 assignee id（≤100，超出静默截断） */
  assigneeIds: z.string().min(1),
});
export type LastDoneQuery = z.infer<typeof lastDoneQuerySchema>;

export const changedFilesQuerySchema = z.object({
  /** 逗号分隔 WU id（≤100，超出静默截断）；缺省 = 空映射 */
  ids: z.string().optional(),
});
export type ChangedFilesQuery = z.infer<typeof changedFilesQuerySchema>;

export const wuIdParamsSchema = z.object({ id: z.string().min(1) });
export type WuIdParams = z.infer<typeof wuIdParamsSchema>;

export const opportunityParamsSchema = z.object({
  id: z.string().min(1),
  oppId: z.string().min(1),
});
export type OpportunityParams = z.infer<typeof opportunityParamsSchema>;

export const messageParamsSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
});
export type MessageParams = z.infer<typeof messageParamsSchema>;

/** GET /:id/messages（before = ISO 游标；limit 数字串，handler 归一 ≤100） */
export const listMessagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.string().optional(),
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

// ── 请求：body ──

/** 宿主执行记录只能由服务端执行链落档，不能经普通 REST metadata 伪造。 */
const restWorkUnitMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, ctx) => {
  for (const key of ['worktreePath', 'verifyCommands', 'mergeIntent', 'mergeReceipt', 'mergedAt', 'mergeCommit'] as const) {
    if (key in metadata) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `metadata.${key} 只能由服务端执行链写入`,
      });
    }
  }
});

/** 已建 WU 的仓库、腿与预算只能经 Mandate 授权命令变更。 */
const updateWorkUnitMetadataSchema = restWorkUnitMetadataSchema.superRefine((metadata, ctx) => {
  for (const key of ['workspaceRoot', 'pmoBranch', 'tokenBudget', 'planStepAllowance'] as const) {
    if (key in metadata) {
      ctx.addIssue({ code: 'custom', path: [key], message: `metadata.${key} 只能经 Mandate 授权命令变更` });
    }
  }
});

/** POST / 建单（路由只透传这些字段；workspaceId/reqId 等列由机制路径写入，REST 不收） */
export const createWorkUnitBodySchema = z.object({
  scope: z.string().min(1),
  type: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.string().optional(),
  channelId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  metadata: restWorkUnitMetadataSchema.optional(),
  projectPath: z.string().nullable().optional(),
});
export type CreateWorkUnitBody = z.infer<typeof createWorkUnitBodySchema>;

/**
 * PUT /:id 更新（全可选补丁；null = 显式清除）。
 * timeoutAt/completedAt 服务端按 Date 处理——REST 传非 null 字符串会 500（旧行为如此，遗留问题）。
 */
export const updateWorkUnitBodySchema = z.object({
  type: z.string().optional(),
  scope: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  channelId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  projectPath: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  reqId: z.string().nullable().optional(),
  failureType: z.string().nullable().optional(),
  retryCount: z.number().optional(),
  timeoutAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  metadata: updateWorkUnitMetadataSchema.optional(),
});
export type UpdateWorkUnitBody = z.infer<typeof updateWorkUnitBodySchema>;

/** POST /from-message 涌现建单 */
export const fromMessageBodySchema = z.object({
  messageId: z.string().min(1),
  type: z.string().optional(),
  metadata: restWorkUnitMetadataSchema.optional(),
  /** #524：可选透传频道 → 按频道直查，免全频道扫描反查 */
  channelId: z.string().optional(),
});
export type FromMessageBody = z.infer<typeof fromMessageBodySchema>;

/** POST /:id/claim（agentId 可省略 = 当前登录用户） */
export const claimBodySchema = z.object({
  agentId: z.string().min(1).optional(),
});
export type ClaimBody = z.infer<typeof claimBodySchema>;

/** #706：扩权/重新授权只收范围，不收请求人或操作人；主体由服务端会话决定。 */
export const authorizeMandateBodySchema = z.object({
  repositories: z.array(z.object({ repo: z.string().min(1), leg: z.string().nullable() })).optional(),
  deliveryActions: z.array(z.enum(['merge', 'deliver', 'mark-delivered'])).optional(),
  budget: z.object({
    tokens: z.number().positive().nullable().optional(),
    planSteps: z.number().positive().nullable().optional(),
  }).optional(),
  reason: z.string().optional(),
});
export type AuthorizeMandateBody = z.infer<typeof authorizeMandateBodySchema>;

export const revokeMandateBodySchema = z.object({ reason: z.string().optional() });
export type RevokeMandateBody = z.infer<typeof revokeMandateBodySchema>;

/** POST /:id/status（human-only；authorType 为 A2A §4.4 自声明身份，requireHuman 消费） */
export const transitionStatusBodySchema = z.object({
  status: z.string().min(1),
  authorType: z.string().optional(),
});
export type TransitionStatusBody = z.infer<typeof transitionStatusBodySchema>;

/** #463：review-passed 结构化确认表单（后端 confirm-payload.ts 语义校验正本，此处为形状契约） */
export const reviewConfirmPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decision'), conclusion: z.string().optional() }),
  z.object({
    kind: z.literal('spec'),
    tasks: z.array(z.object({
      title: z.string(),
      ac: z.array(z.string()).optional(),
      blockedBy: z.array(z.string()).optional(),
      leg: z.string().optional(),
    })).optional(),
  }),
  z.object({
    kind: z.literal('analysis'),
    destination: z.string().optional(),
    fog: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('plan'),
    destination: z.string().optional(),
    fog: z.array(z.string()).optional(),
    tasks: z.array(z.union([
      z.string(),
      z.object({
        title: z.string(),
        ac: z.array(z.string()).optional(),
        blockedBy: z.array(z.string()).optional(),
        leg: z.string().optional(),
      }),
    ])).optional(),
  }),
]);
export type ReviewConfirmPayload = z.infer<typeof reviewConfirmPayloadSchema>;

/** POST /:id/review-passed（human-only） */
export const reviewPassedBodySchema = z.object({
  summary: z.string().optional(),
  defaultAssigneeId: z.string().optional(),
  confirm: reviewConfirmPayloadSchema.optional(),
  authorType: z.string().optional(),
});
export type ReviewPassedBody = z.infer<typeof reviewPassedBodySchema>;

/** POST /:id/review-rejected（human-only） */
export const reviewRejectedBodySchema = z.object({
  reason: z.string().optional(),
  authorType: z.string().optional(),
});
export type ReviewRejectedBody = z.infer<typeof reviewRejectedBodySchema>;

/** POST /:id/verify（human-only；只运行服务端登记检查，不接受调用方命令） */
export const verifyBodySchema = z.object({
  authorType: z.string().optional(),
}).strict();
export type VerifyBody = z.infer<typeof verifyBodySchema>;

/** #467：POST /:id/ruling 裁决轮提交（accept 必须带 conclusion——语义校验在 plan-ruling） */
export const planRulingPayloadSchema = z.object({
  items: z.array(z.object({
    question: z.string(),
    action: z.enum(['accept', 'reopen']),
    conclusion: z.string().optional(),
  })).min(1),
});
export type PlanRulingPayload = z.infer<typeof planRulingPayloadSchema>;

/** #567：POST /:id/direction 方向锁定提交（choice 须在候选内——语义校验在 plan-direction） */
export const planDirectionPayloadSchema = z.object({
  choice: z.string().min(1),
  note: z.string().optional(),
});
export type PlanDirectionPayload = z.infer<typeof planDirectionPayloadSchema>;

/** POST /:id/opportunities/:oppId/ignore */
export const ignoreOpportunityBodySchema = z.object({
  reason: z.string().optional(),
});
export type IgnoreOpportunityBody = z.infer<typeof ignoreOpportunityBodySchema>;

/** POST /:id/messages 讨论区发消息（authorType 自声明；agent 需带 agentName 才走 agent 通道） */
export const postMessageBodySchema = z.object({
  content: z.string().trim().min(1),
  replyToId: z.string().optional(),
  authorType: z.string().optional(),
  agentName: z.string().optional(),
});
export type PostMessageBody = z.infer<typeof postMessageBodySchema>;

/** PATCH /:id/messages/:messageId（content/meta 至少其一——handler 守卫） */
export const patchMessageBodySchema = z.object({
  content: z.string().optional(),
  meta: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
});
export type PatchMessageBody = z.infer<typeof patchMessageBodySchema>;

// ── 响应 ──

/** GET / 列表：`{ data, pagination }` */
export const workUnitListResponseSchema = paginatedBodySchema(workUnitSchema);

/** 单 WorkUnit 端点通用壳：`{ data: WorkUnit }`（get/create/update/claim/unclaim/status/review×2/resume/close/ruling/direction） */
export const workUnitResponseSchema = dataBodySchema(workUnitSchema);

/** GET /last-done：`{ data: Record<assigneeId, WorkUnit | null> }` */
export const lastDoneResponseSchema = dataBodySchema(z.record(z.string(), workUnitSchema.nullable()));
export type LastDoneResult = Record<string, WorkUnit | null>;

/** GET /changed-files：`{ data: { filesByWu } }` */
export const changedFilesResponseSchema = dataBodySchema(z.object({
  filesByWu: z.record(z.string(), z.array(z.string())),
}));
export type ChangedFilesResult = z.infer<typeof changedFilesResponseSchema>['data'];

/** GET /:id/tree-tokens：`{ data: TreeTokenReport }` */
export const treeTokenReportResponseSchema = dataBodySchema(treeTokenReportSchema);

/** F6-c verify 业务结果（200 verified/failed 与 422 no-commands 共用形状，422 也包 { data }） */
export const verifyResultSchema = z.object({
  verified: z.boolean(),
  report: z.unknown().optional(),
  failed: z.array(z.object({ command: z.string(), tail: z.string() })).optional(),
  reason: z.string().optional(),
  hint: z.string().optional(),
});
export type VerifyResult = z.infer<typeof verifyResultSchema>;
export const verifyResultResponseSchema = dataBodySchema(verifyResultSchema);

/** POST /:id/dispatch-review：`{ data: { reviewWorkUnitId } }` */
export const dispatchReviewResultSchema = z.object({ reviewWorkUnitId: z.string() });
export type DispatchReviewResult = z.infer<typeof dispatchReviewResultSchema>;
export const dispatchReviewResponseSchema = dataBodySchema(dispatchReviewResultSchema);

/** POST adopt：`{ data: { workUnit, opportunities } }`（201） */
export const adoptOpportunityResultSchema = z.object({
  workUnit: workUnitSchema,
  opportunities: z.array(inspectionOpportunitySchema),
});
export type AdoptOpportunityResult = z.infer<typeof adoptOpportunityResultSchema>;
export const adoptOpportunityResponseSchema = dataBodySchema(adoptOpportunityResultSchema);

/** POST ignore：`{ data: { opportunities } }` */
export const ignoreOpportunityResultSchema = z.object({
  opportunities: z.array(inspectionOpportunitySchema),
});
export type IgnoreOpportunityResult = z.infer<typeof ignoreOpportunityResultSchema>;
export const ignoreOpportunityResponseSchema = dataBodySchema(ignoreOpportunityResultSchema);

/** GET /:id/messages：`{ data: { messages, total, hasMore } }`（cursor 分页，非 page/limit 壳） */
export const discussionMessagesResultSchema = z.object({
  messages: z.array(discussionMessageSchema),
  total: z.number(),
  hasMore: z.boolean(),
});
export type DiscussionMessagesResult = z.infer<typeof discussionMessagesResultSchema>;
export const discussionMessagesResponseSchema = dataBodySchema(discussionMessagesResultSchema);

/** POST/PATCH messages：`{ data: DiscussionMessage }`（POST 201） */
export const discussionMessageResponseSchema = dataBodySchema(discussionMessageSchema);
