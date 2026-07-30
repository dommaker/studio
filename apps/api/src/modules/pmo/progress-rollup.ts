/**
 * B3a 工程归属链（决策 D2）：PMO 项目进度回写。
 *
 * 订阅 workunit.status_changed：变更 WU 关联的 Requirement 挂了 projectId 时，
 * 按该项目下全部 Requirement 关联 WU 的完结比例重算 project.progress；
 * 全部完结 → status 置 completed（skipValidation 系统汇总直写，
 * updateStatus 自动带 completedAt 与 progress=100）。
 * analysis 派生链（analysis-handoff）的 task WU 无 reqId，仅 metadata.pmoId
 * 溯源——Requirement 链路拿不到关联 WU 时回退按 pmoId 归属，口径不变。
 *
 * 完结口径与 REQ 状态汇总一致（TERMINAL_WORKUNIT_STATUSES：in_review 视同工作完成）。
 * best-effort：任何失败仅记日志，不阻断事件主流程。
 */
import { eventBus, FileStore, logger } from '@dommaker/studio-shared';
import { RequirementService, TERMINAL_WORKUNIT_STATUSES } from '../requirements/requirement.service.js';
import { projectService, PROJECT_STATUS } from './project.service.js';

/** analysis 派生 WU 的 PMO 溯源字段：metadata.pmoId（JSON 字符串，容错解析） */
export function parseWuMetaPmoId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const pmoId = (JSON.parse(metadata) as { pmoId?: unknown }).pmoId;
    return typeof pmoId === 'string' && pmoId.length > 0 ? pmoId : null;
  } catch {
    return null;
  }
}

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
 * 重算单个 PMO 项目进度：该项目下全部 Requirement 关联 WU 的完结比例。
 * Requirement 链路拿不到关联 WU 时回退按 metadata.pmoId 归属统计（analysis 派生链），口径不变。
 * completed/cancelled 项目不再回写；无关联 WU 时不动作。
 */
export async function syncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) return;
  if (project.status === PROJECT_STATUS.COMPLETED || project.status === PROJECT_STATUS.CANCELLED) return;

  const fs = fileStore ?? new FileStore();
  const reqService = new RequirementService(fs);
  const linkedReqs = (await reqService.list()).filter(r => r.projectId === projectId);

  const reqIds = new Set(linkedReqs.map(r => r.id));
  const index = await fs.getIndex();
  let snapshots = index.filter(s => s.reqId && reqIds.has(s.reqId));
  if (snapshots.length === 0) {
    // analysis 派生链：task WU 无 reqId，仅 metadata.pmoId 溯源
    snapshots = index.filter(s => parseWuMetaPmoId(s.metadata) === projectId);
  }
  if (snapshots.length === 0) return;

  const done = snapshots.filter(s => TERMINAL_WORKUNIT_STATUSES.includes(s.status)).length;
  const progress = Math.round((done / snapshots.length) * 100);

  if (done === snapshots.length) {
    await projectService.updateStatus(projectId, PROJECT_STATUS.COMPLETED, true);
    logger.info('[PMO] Project completed (all requirement workunits done)', {
      projectId,
      workUnitCount: snapshots.length,
    });
  } else if (progress !== project.progress) {
    await projectService.update(projectId, { progress });
    logger.info('[PMO] Project progress updated', { projectId, progress, done, total: snapshots.length });
  }
}
