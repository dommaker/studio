// ── Trigger EXECUTE handler 注册（周期扫描类）──
// P2-a：自 apps/api/src/index.ts 拆出。注册顺序与原 index.ts 逐行一致。
// 2026-10-03 根因修复（C 批）：listen 前移（ff546ba9）后本步 throw 会经 bootstrap
// catch 落到 process.exit(1)，发生在端口可服务之后——「失败只 log 不拒启」，
// #686 起纪律固化在 soft-steps.ts。表驱动：新增扫描 handler = SCAN_HANDLERS 加一行。

import { getStore } from '../core/store.js';
import { runSoftSteps } from './soft-steps.js';
import { logger } from '@dommaker/studio-shared/node';

type ScanHandler = readonly [string, () => Promise<void>];

const SCAN_HANDLERS: readonly ScanHandler[] = [
  // ── Agent Timeout Scan（超时释放 handler）──
  ['agent-timeout-scan', async () => {
    const { scanStaleAgentInstances } = await import('../modules/ops/index.js');
    const result = await scanStaleAgentInstances(getStore());
    if (result.terminated > 0) logger.info(`[AgentTimeout] Terminated ${result.terminated} stale instances`);
  }],
  // ── F5: NEED_INPUT 挂起超时提醒 handler ──
  ['workunit-input-reminder-scan', async () => {
    const { scanWaitingForInputReminders } = await import('../modules/workunit/index.js');
    await scanWaitingForInputReminders();
  }],
  // ── #523: 人闸催办与认领滞留 handler（workunit-gate-escalation 触发器，5min）──
  ['workunit-gate-escalation-scan', async () => {
    const { scanGateEscalationReminders } = await import('../modules/workunit/index.js');
    await scanGateEscalationReminders();
  }],
  // ── P0: WorkUnit 执行超时释放 handler（workunit-timeout 触发器）──
  ['workunit-timeout-scan', async () => {
    const { scanTimedOutWorkUnits } = await import('../modules/workunit/index.js');
    await scanTimedOutWorkUnits();
  }],
  // ── #183: 派工/评审断链对账 handler（dispatch-reconciliation 触发器，5min）──
  ['dispatch-reconciliation-scan', async () => {
    const { reconcileDispatchBreaks } = await import('../modules/agent-loop/index.js');
    await reconcileDispatchBreaks();
    const { WorkUnitService, recoverWorktreeMerges } = await import('../modules/workunit/index.js');
    const fileStore = getStore();
    await recoverWorktreeMerges(new WorkUnitService(fileStore), fileStore);
  }],
];

export async function registerScanHandlers(): Promise<void> {
  await runSoftSteps([{ name: 'ScanHandlers', run: registerScanHandlersInner }]);
}

async function registerScanHandlersInner(): Promise<void> {
  const { registerExecuteHandler } = await import('../modules/triggers/index.js');
  for (const [name, fn] of SCAN_HANDLERS) registerExecuteHandler(name, fn);
  // ── E1 约束进化（vision §6）：evolution-scan handler + review-proposal adapter 注册（#623 正本卡片人审）──
  // 单次 import 两用：构造单例即注册 adapter（kind='evolution'）——保证通用审批端点
  // /review-proposals/evolution/* 在首次扫描前已可分发；scan handler 闭包复用同一引用。
  const { getEvolutionService } = await import('../modules/evolution/index.js');
  getEvolutionService();
  registerExecuteHandler('evolution-scan', async () => {
    const result = await getEvolutionService().runScan();
    if (result.created.length > 0) {
      logger.info(`[Evolution] Daily scan created ${result.created.length} proposal(s)`);
    }
  });
}
