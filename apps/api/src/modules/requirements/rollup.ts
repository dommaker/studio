/**
 * REQ 状态汇总（vision §5.3）：订阅 workunit.status_changed，
 * 一个需求的全部 WorkUnit 到达终态 → Requirement status = done。
 * best-effort：汇总失败仅记日志。
 */
import { eventBus, logger } from '@dommaker/studio-shared';
import { RequirementService } from './requirement.service.js';

/**
 * 挂载汇总订阅，返回解绑函数（测试用）。
 * 生产环境在 API 启动时调用一次（见 apps/api/src/index.ts）。
 */
export function initRequirementRollup(service?: RequirementService): () => void {
  const svc = service ?? new RequirementService();
  const handler = (payload: { workunit?: { reqId?: string | null } }) => {
    const reqId = payload?.workunit?.reqId;
    if (!reqId) return;
    svc.maybeRollUpToDone(reqId).catch(err =>
      logger.warn('[Requirement] Rollup failed (non-blocking)', { reqId, error: String(err) })
    );
  };
  eventBus.subscribe('workunit.status_changed', handler);
  return () => eventBus.unsubscribe('workunit.status_changed', handler);
}
