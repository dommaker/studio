// ── 核心服务启动（监控/审计/rollup/巡检/进化调度）──
// P2-a：自 apps/api/src/index.ts 拆出。调用顺序与原 index.ts 逐行一致：
// monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → WorkUnitMergeRecovery → EvolutionScheduler。
// #686：表驱动 + runSoftSteps 单循环，「失败只 log 不拒启」纪律固化在 soft-steps.ts
// （monitor/auditor 两个裸 start 一并纳入软启动纪律）；新增服务 = CORE_SERVICES 加一行。
import { startEvolutionScheduler } from '../modules/knowledge/index.js';
import { getMonitorService } from '../modules/ops/index.js';
import { getAuditorService } from '../modules/agent-auditor/index.js';
import { runSoftSteps, type SoftStep } from './soft-steps.js';

const CORE_SERVICES: readonly SoftStep[] = [
  { name: 'Monitor', run: () => getMonitorService().start() },
  { name: 'Auditor', run: () => getAuditorService().start() },
  {
    // REQ 需求编号体系（vision §5.3）：WorkUnit 终态 → Requirement done 状态汇总
    name: 'RequirementRollup',
    run: async () => (await import('../modules/requirements/index.js')).initRequirementRollup(),
  },
  {
    // B3a 工程归属链（决策 D2）：WorkUnit 状态 → PMO 项目进度回写
    name: 'PmoProgressRollup',
    run: async () => (await import('../modules/pmo/index.js')).initPmoProgressRollup(),
  },
  {
    name: 'OpsService',
    run: async () => (await import('../modules/ops/index.js')).createOpsService().start(),
  },
  {
    name: 'WorkUnitMergeRecovery',
    run: async () => {
      const { getStore } = await import('../core/store.js');
      const { WorkUnitService, recoverWorktreeMerges } = await import('../modules/workunit/index.js');
      const fileStore = getStore();
      await recoverWorktreeMerges(new WorkUnitService(fileStore), fileStore);
    },
  },
  { name: 'EvolutionScheduler', run: () => startEvolutionScheduler() },
];

export async function startCoreServices(): Promise<void> {
  await runSoftSteps(CORE_SERVICES);
}
