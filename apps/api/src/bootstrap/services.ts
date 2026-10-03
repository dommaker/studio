// ── 核心服务启动（监控/审计/rollup/巡检/进化调度）──
// P2-a：自 apps/api/src/index.ts 拆出。调用顺序与原 index.ts 逐行一致：
// monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → EvolutionScheduler。
import { logger } from '@dommaker/studio-shared';
import { startEvolutionScheduler } from '../modules/knowledge/index.js';
import { monitorService } from '../modules/agent-monitor/index.js';
import { auditorService } from '../modules/agent-auditor/index.js';

export async function startCoreServices(): Promise<void> {
  monitorService.start();
  auditorService.start();
  // B4a（决策 D8）: studio-daemon（pipeline 时代 session 管理器）已整体删除——
  // start() 从未被调用、submitJob 无生产调用方、reviewer session 泄漏 worktree；
  // AS-020 P5 HTTP claim 竖井（daemon-routes/task-routes/discover-proxy）随客户端
  // 三件套删除后无任何消费者，一并删除（2026-08-04 第一性复审）。
  // REQ 需求编号体系（vision §5.3）：WorkUnit 终态 → Requirement done 状态汇总
  try {
    const { initRequirementRollup } = await import('../modules/requirements/index.js');
    initRequirementRollup();
    logger.info('[Requirement] Rollup subscribed (workunit.status_changed → done)');
  } catch (e) { logger.warn('[Requirement] Rollup init failed', { error: String(e) }); }
  // B3a 工程归属链（决策 D2）：WorkUnit 状态 → PMO 项目进度回写
  try {
    const { initPmoProgressRollup } = await import('../modules/pmo/index.js');
    initPmoProgressRollup();
    logger.info('[PMO] Progress rollup subscribed (workunit.status_changed → project progress)');
  } catch (e) { logger.warn('[PMO] Progress rollup init failed', { error: String(e) }); }
  // ── Ops Service: runtime health loop ──
  try {
    const { createOpsService } = await import('../modules/agent-ops/index.js');
    const opsService = createOpsService();
    opsService.start();
  } catch (e) { logger.warn('[OpsService] Failed to start', { error: String(e) }); }
  try { startEvolutionScheduler(); } catch { logger.warn('Evolution scheduler unavailable'); }
}
