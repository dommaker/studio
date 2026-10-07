/**
 * WorkUnit Service 门面 —— 继承链末层 + 兼容 re-export（导入面不变）。
 *
 * AS-025 §3.28c-1 Task 2-4
 * 存储迁移: 已从 Prisma 迁移到 FileStore (Event Sourcing)
 *
 * 分层（#672 按职责拆分，纯代码移动，行为不变；每层一个文件，继承链串起）：
 *   workunit-crud.ts      WorkUnitCrudService      CRUD + Claim + updateMetadata 增量语义口（#554）
 *   workunit-query.ts     WorkUnitQueryService     查询派生（getById / list / lastDoneByAssignee）
 *   workunit-lifecycle.ts WorkUnitLifecycleService 状态机（transitionStatus / close / persistSnapshot 统一尾部 / rebindSourceChannel）
 *   workunit-review.ts    WorkUnitReviewService    评审验收（reviewPassed/reviewRejected/attestation 补写/recordL1Verification/verifyManually/markMergeConflict/blockForManualRelease/blockForAllUnfit）
 * 头部类型/常量/转换层在 workunit.types.ts / workunit.mappers.ts（工单 30）。
 * 结构基线由 __tests__/workunit-service-split.test.ts 钉住。
 */

import { WorkUnitReviewService } from './workunit-review.js';

export class WorkUnitService extends WorkUnitReviewService {}

// re-export：保持既有消费方（agent-loop / routes / 测试等）从 workunit.service 导入的路径不变
export { waitForReviewPassSettled } from './workunit-review.js';
export type { ManualVerifyResult } from './workunit-review.js';
export { snapshotToData } from './workunit.mappers.js';
export { ANALYSIS_TASKS_MAX, INSPECTION_OPPORTUNITIES_MAX } from './workunit.types.js';
export type { WorkUnitMetadata, ReviewAttestationSource, InspectionOpportunity, CloseWorkUnitOptions, WorkUnitClosedBy } from './workunit.types.js';

// 拆分后兼容 re-export（原导入方零改动）：以下符号已迁至 workunit-crud.ts / workunit.types.ts
export type { CreateWorkUnitInput, UpdateWorkUnitInput, WorkUnitData } from './workunit-crud.js';
export { WU_LEASE_TTL_MS } from './workunit.types.js';

export type { WorkUnitSnapshot, WorkUnitFilter } from '@dommaker/studio-shared';
