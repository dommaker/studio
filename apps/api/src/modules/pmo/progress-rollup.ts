/**
 * B3a 工程归属链（决策 D2）：PMO 项目进度回写。
 *
 * 订阅 workunit.status_changed：变更 WU 关联的 Requirement 挂了 projectId 时，
 * 按该项目下全部 Requirement 关联 WU 的完结比例重算 project.progress；
 * 全部完结 → 证据感知翻转（2026-07-30 根因修复，此前不看交付证据直接 completed）：
 *   - 证据齐（evidence-summary 共享口径 deliverable）→ completed；
 *   - 证据有缺口 → active/pending 项目置 in_review（活干完了，等证据验收），
 *     已是 in_review 则不动；completed/cancelled 项目入口即跳过（不回退）。
 *   幂等补写证据（l2/l3 后补）不产生状态迁移事件，靠 GET /pmo/project/:id
 *   读取时的 best-effort 重算（routes.ts:107）纠偏翻 completed。
 * analysis 派生链（analysis-handoff）的 task WU 无 reqId，仅 metadata.pmoId
 * 溯源——Requirement 链路拿不到关联 WU 时回退按 pmoId 归属，口径不变。
 *
 * 完结口径与 REQ 状态汇总一致（TERMINAL_WORKUNIT_STATUSES：in_review 视同工作完成）。
 * progress 语义 = 「活干完了多少」，与证据口径无关。
 * best-effort：任何失败仅记日志，不阻断事件主流程。
 */
import { eventBus, FileStore, logger } from '@dommaker/studio-shared';
import { RequirementService, TERMINAL_WORKUNIT_STATUSES } from '../requirements/requirement.service.js';
import { projectService, PROJECT_STATUS } from './project.service.js';
import { parseWuMetaPmoId, selectProjectSnapshots, summarizeEvidence } from './evidence-summary.js';

// 兼容现有引用方（原定义已移至 evidence-summary.ts 共享口径）
export { parseWuMetaPmoId };

/**
 * 挂载进度回写订阅，返回解绑函数（测试用）。
 * 生产环境在 API 启动时调用一次（见 apps/api/src/index.ts）。
 */
export function initPmoProgressRollup(fileStore?: FileStore): () => void {
  const handler = (payload: { workunit?: { reqId?: string | null; metadata?: string | null } }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    if (wu.reqId) {
      syncProjectProgressByReqId(wu.reqId, fileStore).catch(err =>
        logger.warn('[PMO] Progress rollup failed (non-blocking)', { reqId: wu.reqId, error: String(err) })
      );
      return;
    }
    // analysis 派生链：无 reqId，经 metadata.pmoId 找到项目再 rollup
    const pmoId = parseWuMetaPmoId(wu.metadata);
    if (!pmoId) return;
    syncProjectProgress(pmoId, fileStore).catch(err =>
      logger.warn('[PMO] Progress rollup failed (non-blocking)', { projectId: pmoId, error: String(err) })
    );
  };
  eventBus.subscribe('workunit.status_changed', handler);
  return () => eventBus.unsubscribe('workunit.status_changed', handler);
}

/** WU 状态变更入口：经其 reqId 找到挂接的 PMO 项目并重算进度 */
export async function syncProjectProgressByReqId(reqId: string, fileStore?: FileStore): Promise<void> {
  const reqService = new RequirementService(fileStore);
  const requirement = await reqService.get(reqId);
  if (!requirement?.projectId) return;
  await syncProjectProgress(requirement.projectId, fileStore);
}

/**
 * 同一项目的回写串行化：status_changed 事件是 fire-and-forget，相邻两次迁移
 * （如 WU in_review → done）会并发触发回写——不串行时慢到的 in_review 写可能
 * 覆盖先到的 completed。按 projectId 链式排队，前序失败不阻断后续。
 */
const syncChains = new Map<string, Promise<void>>();

/**
 * 重算单个 PMO 项目进度：该项目下全部 Requirement 关联 WU 的完结比例。
 * Requirement 链路拿不到关联 WU 时回退按 metadata.pmoId 归属统计（analysis 派生链），口径不变。
 * completed/cancelled 项目不再回写（不回退）；无关联 WU 时不动作。
 * 全部完结时按证据翻转：deliverable → completed；否则 active/pending → in_review（等证据验收）。
 */
export function syncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  const run = (syncChains.get(projectId) ?? Promise.resolve())
    .catch(() => { /* 前序失败不阻断后续 */ })
    .then(() => doSyncProjectProgress(projectId, fileStore));
  syncChains.set(projectId, run);
  // 链尾回收，避免 Map 随项目数无限增长
  const cleanup = () => { if (syncChains.get(projectId) === run) syncChains.delete(projectId); };
  run.then(cleanup, cleanup);
  return run;
}

async function doSyncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) return;
  if (project.status === PROJECT_STATUS.COMPLETED || project.status === PROJECT_STATUS.CANCELLED) return;

  const fs = fileStore ?? new FileStore();
  const reqService = new RequirementService(fs);
  const snapshots = selectProjectSnapshots(projectId, await reqService.list(), await fs.getIndex());
  if (snapshots.length === 0) return;

  const done = snapshots.filter(s => TERMINAL_WORKUNIT_STATUSES.includes(s.status)).length;
  const progress = Math.round((done / snapshots.length) * 100);

  if (done === snapshots.length) {
    const summary = summarizeEvidence(snapshots);
    if (summary.deliverable) {
      // 证据齐 → completed（skipValidation 系统汇总直写，自动带 completedAt 与 progress=100）
      await projectService.updateStatus(projectId, PROJECT_STATUS.COMPLETED, true);
      logger.info('[PMO] Project completed (all requirement workunits done)', {
        projectId,
        workUnitCount: snapshots.length,
      });
    } else if (project.status === PROJECT_STATUS.ACTIVE || project.status === PROJECT_STATUS.PENDING) {
      // 活干完了但证据有缺口 → in_review（等证据验收），不冒充 completed；
      // 已是 in_review 则不动。幂等补写证据不产生状态事件，
      // 靠 GET /pmo/project/:id 读取时的 best-effort 重算纠偏翻 completed。
      if (progress !== project.progress) await projectService.update(projectId, { progress });
      await projectService.updateStatus(projectId, PROJECT_STATUS.IN_REVIEW, true);
      logger.info('[PMO] Project in_review (work finished, evidence gaps)', {
        projectId,
        workUnitCount: snapshots.length,
        l1Missing: summary.l1Missing.length,
        l2Missing: summary.l2Missing.length,
        l3Missing: summary.l3Missing.length,
      });
    }
  } else if (progress !== project.progress) {
    await projectService.update(projectId, { progress });
    logger.info('[PMO] Project progress updated', { projectId, progress, done, total: snapshots.length });
  }
}
