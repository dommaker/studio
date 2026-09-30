/**
 * pmo 域契约——正本字段以 apps/api/src/modules/pmo/project.service.ts（ProjectData）、
 * okr.service.ts（OKRObjective/OKRKeyResult/list 行）、delivery.ts（DeliveryStatus/DeliverOutcome）为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（原裸对象 / `{success,data}` / 平铺错误壳退役）
 * - POST /project/:id/deliver 与 /mark-delivered 的 409 拒绝体为错误壳扩展
 *   `{ error: { code, message, missing?, conflictFiles? } }`（handler 自写 res，前端 DeliveryPanel 消费）
 * - GET /project 列表 query 的 limit/page 为数字串（handler 走 parsePagination clamp 1..100，缺省 20）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';
import { channelMessageSchema } from './channels.js';
import { workUnitSchema } from './workunit.js';

// ── 实体：Project ──

/** PMO 交付策略：auto-merge=studio 执行合并（缺证据硬拒）；branch-only=默认，只标证据齐缺 */
export const deliveryPolicySchema = z.enum(['auto-merge', 'branch-only']);
export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

/** 决策落地记录（decision 单人工确认时填写的一句话结论，机制原样存） */
export const pmoDecisionSchema = z.object({
  wuId: z.string(),
  summary: z.string(),
  resolvedAt: z.string(),
});
/** 手写 interface（前后端均按必填消费——project.service PmoDecision / web mapUtils） */
export interface PmoDecision {
  wuId: string;
  summary: string;
  resolvedAt: string;
}

export const fogStatusSchema = z.enum(['open', 'in-discussion', 'resolved']);
export type FogStatus = z.infer<typeof fogStatusSchema>;

/** 雾条目（待决问题）；wuId = 认领该问题的 decision WU，未认领为 null */
export const fogItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  wuId: z.string().nullable(),
  status: fogStatusSchema,
});
/** 手写 interface（前后端均按必填消费——project.service FogItem / web mapUtils） */
export interface FogItem {
  id: string;
  question: string;
  wuId: string | null;
  status: FogStatus;
}

/** 探路地图（缺省 null = 非探路型需求） */
export const pmoMapSchema = z.object({
  destination: z.string(),
  decisions: z.array(pmoDecisionSchema),
  fog: z.array(fogItemSchema),
  /** 雾全清后 spec 成文单已派生时间戳（幂等哨兵） */
  specSpawnedAt: z.string().optional(),
  /** 自动建成的 spec 单 id（溯源回写） */
  specWuId: z.string().nullable().optional(),
});
/** 手写 interface（前后端均按必填消费——project.service PmoMap / web mapUtils） */
export interface PmoMap {
  destination: string;
  decisions: PmoDecision[];
  fog: FogItem[];
  specSpawnedAt?: string;
  specWuId?: string | null;
}

/** #113 T7 腿状态词表（progress-rollup 逐腿回写；delivered 为终态不被回写） */
export const deliveryLegStatusSchema = z.enum(['pending', 'active', 'in_review', 'completed', 'delivered']);
export type DeliveryLegStatus = z.infer<typeof deliveryLegStatusSchema>;

/** 交付腿（多腿交付按腿独立台账/合并/状态） */
export const deliveryLegSchema = z.object({
  gitRepo: z.string().nullable(),
  branch: z.string().nullable(),
  status: deliveryLegStatusSchema,
  deliveredAt: z.string().nullable().optional(),
  deliverCommit: z.string().nullable().optional(),
});
export type DeliveryLeg = z.infer<typeof deliveryLegSchema>;

/**
 * Project wire 形状（= project.service.ts ProjectData 全字段；读取路径统一合成
 * deliveries 单腿缺省）。手写 interface（z.infer 在本仓 strict:false 下全字段退化可选，
 * 前端 PMOPage/ProjectCard/详情页按必填消费）；parity 测试见 __tests__/pmo.test.ts。
 */
export interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description: string | null;
  requirement: string | null;
  companyId: string | null;
  okrId: string | null;
  status: string;
  priority: string;
  progress: number;
  gitBranch: string | null;
  gitRepo: string | null;
  specFilePath: string | null;
  requirementsDocId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** REQ 只读别名（REQ-XXXX），统一编号对象才有；存量 legacy 项目为 null/缺省 */
  reqAlias?: string | null;
  deliveryPolicy?: DeliveryPolicy;
  /** 杂务 PMO（频道常青小活归集），isChore + channelId 联合标识 */
  isChore?: boolean;
  channelId?: string | null;
  /** auto-merge 交付记录（branch-only 走 mark-delivered 人工落档） */
  deliveredAt?: string | null;
  deliveredBy?: string | null;
  deliverCommit?: string | null;
  map?: PmoMap | null;
  /** 多交付腿（缺省 = 读取时由 gitRepo/gitBranch 合成单腿） */
  deliveries?: DeliveryLeg[];
}

export const projectSchema = z.object({
  id: z.string(),
  pmoNumber: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  requirement: z.string().nullable(),
  companyId: z.string().nullable(),
  okrId: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  progress: z.number(),
  gitBranch: z.string().nullable(),
  gitRepo: z.string().nullable(),
  specFilePath: z.string().nullable(),
  requirementsDocId: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reqAlias: z.string().nullable().optional(),
  deliveryPolicy: deliveryPolicySchema.optional(),
  isChore: z.boolean().optional(),
  channelId: z.string().nullable().optional(),
  deliveredAt: z.string().nullable().optional(),
  deliveredBy: z.string().nullable().optional(),
  deliverCommit: z.string().nullable().optional(),
  map: pmoMapSchema.nullable().optional(),
  deliveries: z.array(deliveryLegSchema).optional(),
});

// ── 实体：OKR ──

export const okrObjectiveSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
});
export type OkrObjective = z.infer<typeof okrObjectiveSchema>;

export const okrKeyResultSchema = z.object({
  id: z.string(),
  objectiveId: z.string(),
  title: z.string(),
  target: z.number(),
  current: z.number(),
  unit: z.string(),
  /** 度量类型（e.g. "pipeline_duration_p90"） */
  metricType: z.string().optional(),
  /** 度量查询参数（e.g. { days: 7 }） */
  queryParams: z.record(z.unknown()).optional(),
});
export type OkrKeyResult = z.infer<typeof okrKeyResultSchema>;

/**
 * OKR 列表行 wire 形状（okr.service.list 返回）。手写 interface（前端 PMOPage/PMOCard
 * 按必填消费；手抄版 objectives/keyResults 可缺省是漂移——后端恒返回）；parity 测试见 __tests__。
 */
export interface Okr {
  id: string;
  companyId: string;
  title: string;
  quarter: string;
  status: string;
  /** 0..1（前端 ×100 渲染） */
  progress: number;
  objectives: OkrObjective[];
  keyResults: OkrKeyResult[];
  createdAt: string;
  updatedAt: string;
  /** 关联执行数（executions.jsonl 计数） */
  projectCount: number;
}

export const okrSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  quarter: z.string(),
  status: z.string(),
  progress: z.number(),
  objectives: z.array(okrObjectiveSchema),
  keyResults: z.array(okrKeyResultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectCount: z.number(),
});

/** OKR 详情（GET /okr/:id）：列表行去 projectCount + 关联占位/最近执行/计数 */
export const okrDetailSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  quarter: z.string(),
  status: z.string(),
  progress: z.number(),
  objectives: z.array(okrObjectiveSchema),
  keyResults: z.array(okrKeyResultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Prisma 时代遗留占位，恒 null */
  Company: z.null(),
  /** 最近 10 条关联执行（jsonl 投影） */
  Execution: z.array(z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })),
  _count: z.object({ Execution: z.number() }),
});
export type OkrDetail = z.infer<typeof okrDetailSchema>;

/** OKR 创建/更新响应（{ id, ...meta, objectives, keyResults }——无 projectCount） */
export const okrMutationResultSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  quarter: z.string(),
  status: z.string(),
  progress: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  objectives: z.array(okrObjectiveSchema),
  keyResults: z.array(okrKeyResultSchema),
});
export type OkrMutationResult = z.infer<typeof okrMutationResultSchema>;

// ── 交付台账（delivery.ts）──

export const deliveryGapSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  /** 缺口层（顺序固定 l1→l2→l3） */
  missing: z.array(z.enum(['l1', 'l2', 'l3'])),
});
export type DeliveryGap = z.infer<typeof deliveryGapSchema>;

export const deliveryWuSummarySchema = z.object({
  total: z.number(),
  finished: z.number(),
  inFlight: z.number(),
  byStatus: z.object({
    unassigned: z.number(),
    active: z.number(),
    inReview: z.number(),
    blocked: z.number(),
  }),
});

export const deliveryEvidenceSchema = z.object({
  l1Missing: z.array(z.string()),
  l2Missing: z.array(z.string()),
  l3Missing: z.array(z.string()),
  selfReviewCount: z.number(),
});

/** #113 T7：单腿台账（口径与项目级相同，按腿 WU 集独立汇总） */
export const legDeliveryStatusSchema = z.object({
  gitRepo: z.string().nullable(),
  branch: z.string().nullable(),
  status: deliveryLegStatusSchema,
  deliveredAt: z.string().nullable(),
  deliverCommit: z.string().nullable(),
  wu: deliveryWuSummarySchema,
  evidence: deliveryEvidenceSchema,
  deliverable: z.boolean(),
  missing: z.array(z.string()),
  gaps: z.array(deliveryGapSchema),
  tokens: z.number(),
});
export type LegDeliveryStatus = z.infer<typeof legDeliveryStatusSchema>;

/**
 * 交付台账 wire 形状（delivery.ts DeliveryStatus）。手写 interface（前端
 * DeliveryPanel/ProjectProgressCard/详情页按必填消费，测试 fixture 全字段）；
 * parity 测试见 __tests__。前端手抄版缺 channelId 是漂移——后端恒返回。
 */
export interface DeliveryStatus {
  projectId: string;
  pmoNumber: string;
  branch: string | null;
  policy: DeliveryPolicy;
  gitRepo: string | null;
  wu: {
    total: number;
    finished: number;
    inFlight: number;
    byStatus: { unassigned: number; active: number; inReview: number; blocked: number };
  };
  evidence: {
    l1Missing: string[];
    l2Missing: string[];
    l3Missing: string[];
    selfReviewCount: number;
  };
  deliverable: boolean;
  missing: string[];
  /** 项目 WU 链路 token 总消耗（best-effort） */
  tokens: number;
  /** #376 归档口径：completed + 实时重算零 WU */
  archived: boolean;
  gaps: DeliveryGap[];
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliverCommit: string | null;
  /** 项目绑定频道（交付播报发帖用；未 publish 为 null） */
  channelId: string | null;
  /** 逐腿台账（仅显式多腿项目输出；单腿为 undefined） */
  legs?: LegDeliveryStatus[];
}

export const deliveryStatusSchema = z.object({
  projectId: z.string(),
  pmoNumber: z.string(),
  branch: z.string().nullable(),
  policy: deliveryPolicySchema,
  gitRepo: z.string().nullable(),
  wu: deliveryWuSummarySchema,
  evidence: deliveryEvidenceSchema,
  deliverable: z.boolean(),
  missing: z.array(z.string()),
  tokens: z.number(),
  archived: z.boolean(),
  gaps: z.array(deliveryGapSchema),
  deliveredAt: z.string().nullable(),
  deliveredBy: z.string().nullable(),
  deliverCommit: z.string().nullable(),
  channelId: z.string().nullable(),
  legs: z.array(legDeliveryStatusSchema).optional(),
});

/** #113 T7：单腿交付结果（多腿 deliverProject 逐腿产出） */
export const legDeliverResultSchema = z.object({
  gitRepo: z.string().nullable(),
  branch: z.string().nullable(),
  delivered: z.boolean(),
  reason: z.enum(['already-delivered', 'skipped-no-wu', 'no-repo', 'checkout-mismatch', 'conflict']).optional(),
  deliverCommit: z.string().optional(),
  conflictFiles: z.array(z.string()).optional(),
  detail: z.string().optional(),
});
export type LegDeliverResult = z.infer<typeof legDeliverResultSchema>;

/** deliver 成功响应 data（200；拒绝走 409 错误壳扩展，见文件头说明） */
export const deliverResultSchema = z.object({
  delivered: z.literal(true),
  deliverCommit: z.string(),
  legs: z.array(legDeliverResultSchema).optional(),
});
export type DeliverResult = z.infer<typeof deliverResultSchema>;

/** mark-delivered 成功响应 data（200；拒绝走 404/409 错误壳） */
export const markDeliveredResultSchema = z.object({
  delivered: z.literal(true),
  deliverCommit: z.string(),
  deliveredAt: z.string(),
});
export type MarkDeliveredResult = z.infer<typeof markDeliveredResultSchema>;

/** parse-command 响应 data（CEO 指令 PMO 号解析） */
export const parsePmoCommandResultSchema = z.object({
  type: z.enum(['link', 'create', 'auto']),
  pmoNumber: z.string().optional(),
});
export type ParsePmoCommandResult = z.infer<typeof parsePmoCommandResultSchema>;

/** publish 响应 data：频道消息 + plan WU + 更新后项目 */
export const publishProjectResultSchema = z.object({
  message: channelMessageSchema,
  workUnit: workUnitSchema,
  project: projectSchema,
});
export type PublishProjectResult = z.infer<typeof publishProjectResultSchema>;

/** GET /project/:id/sdd 响应 data（关联 spec 条目；无 gitRepo/目录不在 → 空列表） */
export const linkedSddsResultSchema = z.object({
  sddEntries: z.array(z.object({
    slug: z.string(),
    pmoNumber: z.string(),
    status: z.string(),
    title: z.string(),
    tags: z.string(),
  })),
});
export type LinkedSddsResult = z.infer<typeof linkedSddsResultSchema>;

/** DELETE /project/:id 响应 data */
export const deleteProjectResultSchema = z.object({ success: z.boolean() });
export type DeleteProjectResult = z.infer<typeof deleteProjectResultSchema>;

/** DELETE /okr/:id 响应 data（unlinkedProjects = 解除关联的执行数） */
export const deleteOkrResultSchema = z.object({
  success: z.boolean(),
  unlinkedProjects: z.number(),
});
export type DeleteOkrResult = z.infer<typeof deleteOkrResultSchema>;

// ── 请求：query / params ──

/** GET /project（limit/page 数字串，handler 走 parsePagination clamp；companyId 前端会传但后端忽略，zod strip） */
export const listProjectsQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  okrId: z.string().optional(),
  limit: z.string().optional(),
  page: z.string().optional(),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

/** GET /okr（companyId 必填；原 MISSING_COMPANY_ID 手写校验收进 zod） */
export const listOkrsQuerySchema = z.object({
  companyId: z.string().min(1),
  status: z.string().optional(),
});
export type ListOkrsQuery = z.infer<typeof listOkrsQuerySchema>;

export const projectIdParamsSchema = z.object({ id: z.string().min(1) });
export type ProjectIdParams = z.infer<typeof projectIdParamsSchema>;

export const pmoNumberParamsSchema = z.object({ pmoNumber: z.string().min(1) });
export type PmoNumberParams = z.infer<typeof pmoNumberParamsSchema>;

export const okrIdParamsSchema = z.object({ id: z.string().min(1) });
export type OkrIdParams = z.infer<typeof okrIdParamsSchema>;

// ── 请求：body ──

/**
 * POST /project 创建项目。gitRepo/gitRepos 白名单校验（允许根目录之下已存在目录）
 * 在 handler（validateGitRepo，读文件系统，非形状校验）；非字符串字段原静默落库，zod 收紧为 400。
 */
export const createProjectBodySchema = z.object({
  title: z.string().min(1),
  companyId: z.string().optional(),
  description: z.string().optional(),
  requirement: z.string().optional(),
  okrId: z.string().optional(),
  priority: z.string().optional(),
  gitBranch: z.string().optional(),
  gitRepo: z.string().optional(),
  /** #114 T8：多工程入参（非空字符串数组；空数组 = 未传，走旧单选行为） */
  gitRepos: z.array(z.string()).optional(),
  deliveryPolicy: deliveryPolicySchema.optional(),
  requirementsDocId: z.string().optional(),
});
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

/**
 * PUT /project/:id 更新（service 整体展开 body；gitRepo 白名单同 POST 在 handler）。
 * 已知键给类型；未知键 passthrough 保持旧行为（原样落库，service 锁 id/pmoNumber/createdAt）。
 */
export const updateProjectBodySchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  requirement: z.string().optional(),
  okrId: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  progress: z.number().optional(),
  gitBranch: z.string().optional(),
  gitRepo: z.string().optional(),
  gitRepos: z.array(z.string()).optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  deliveryPolicy: deliveryPolicySchema.optional(),
  requirementsDocId: z.string().nullable().optional(),
  deliveredAt: z.string().nullable().optional(),
  deliveredBy: z.string().nullable().optional(),
  deliverCommit: z.string().nullable().optional(),
  map: pmoMapSchema.nullable().optional(),
  deliveries: z.array(deliveryLegSchema).optional(),
}).passthrough();
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;

/** PUT /project/:id/status（原 MISSING_STATUS 手写校验收进 zod；状态机校验在 service → 500 保持旧行为） */
export const updateProjectStatusBodySchema = z.object({
  status: z.string().min(1),
});
export type UpdateProjectStatusBody = z.infer<typeof updateProjectStatusBodySchema>;

/** POST /project/:id/publish（assigneeId 可选 = 显式指派 plan WU 执行角色，留空回池涌现） */
export const publishProjectBodySchema = z.object({
  channelId: z.string().min(1),
  assigneeId: z.string().optional(),
});
export type PublishProjectBody = z.infer<typeof publishProjectBodySchema>;

/** POST /project/parse-command（解析 CEO 指令中的 PMO 号） */
export const parsePmoCommandBodySchema = z.object({
  command: z.string().min(1),
});
export type ParsePmoCommandBody = z.infer<typeof parsePmoCommandBodySchema>;

/**
 * POST /project/:id/mark-delivered（#469：branch-only 人工落档；commit trim 后非空）。
 * human-only 守卫（requireHuman）挂在 defineRoute 之前读原始 body.authorType，
 * schema 不需要保留该键。
 */
export const markDeliveredBodySchema = z.object({
  commit: z.string().trim().min(1),
});
export type MarkDeliveredBody = z.infer<typeof markDeliveredBodySchema>;

/** POST /okr 创建（objectives/keyResults 缺省原 500，zod 收紧为必填 400；每季度唯一约束撞重 → 409 在映射表） */
export const createOkrBodySchema = z.object({
  companyId: z.string().optional(),
  title: z.string().min(1),
  objectives: z.array(okrObjectiveSchema),
  keyResults: z.array(okrKeyResultSchema),
  quarter: z.string().min(1),
});
export type CreateOkrBody = z.infer<typeof createOkrBodySchema>;

/** PUT /okr/:id 更新（全可选；service 只读这四键，未知键旧行为即忽略，zod strip 对齐） */
export const updateOkrBodySchema = z.object({
  title: z.string().optional(),
  objectives: z.array(okrObjectiveSchema).optional(),
  keyResults: z.array(okrKeyResultSchema).optional(),
  status: z.string().optional(),
});
export type UpdateOkrBody = z.infer<typeof updateOkrBodySchema>;

// ── 响应 ──

/** GET /project：`{ data: Project[] }`（原裸 `{ data }` 已带壳，形状不变） */
export const projectListResponseSchema = dataBodySchema(z.array(projectSchema));

/** GET/POST(201)/PUT /project 单体：`{ data: Project }`（原裸对象） */
export const projectResponseSchema = dataBodySchema(projectSchema);

/** GET /project/:id/delivery：`{ data: DeliveryStatus }`（原裸对象） */
export const deliveryStatusResponseSchema = dataBodySchema(deliveryStatusSchema);

/** POST /project/:id/deliver：`{ data: DeliverResult }`（原裸对象；409 为错误壳扩展） */
export const deliverResultResponseSchema = dataBodySchema(deliverResultSchema);

/** POST /project/:id/mark-delivered：`{ data: MarkDeliveredResult }`（原裸对象） */
export const markDeliveredResultResponseSchema = dataBodySchema(markDeliveredResultSchema);

/** POST /project/:id/publish：`{ data: PublishProjectResult }`（原裸对象） */
export const publishProjectResultResponseSchema = dataBodySchema(publishProjectResultSchema);

/** GET /project/:id/sdd：`{ data: LinkedSddsResult }`（原裸对象） */
export const linkedSddsResponseSchema = dataBodySchema(linkedSddsResultSchema);

/** POST /project/parse-command：`{ data: ParsePmoCommandResult }`（原裸对象） */
export const parsePmoCommandResultResponseSchema = dataBodySchema(parsePmoCommandResultSchema);

/** DELETE /project/:id：`{ data: { success } }`（原裸对象） */
export const deleteProjectResultResponseSchema = dataBodySchema(deleteProjectResultSchema);

/** GET /okr：`{ data: Okr[] }`（原裸 `{ data }` 已带壳，形状不变） */
export const okrListResponseSchema = dataBodySchema(z.array(okrSchema));

/** GET /okr/:id：`{ data: OkrDetail }`（原裸对象） */
export const okrDetailResponseSchema = dataBodySchema(okrDetailSchema);

/** POST(201)/PUT /okr：`{ data: OkrMutationResult }`（原裸对象） */
export const okrMutationResultResponseSchema = dataBodySchema(okrMutationResultSchema);

/** DELETE /okr/:id：`{ data: DeleteOkrResult }`（原裸对象） */
export const deleteOkrResultResponseSchema = dataBodySchema(deleteOkrResultSchema);
