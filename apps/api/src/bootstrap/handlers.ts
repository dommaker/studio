// ── Trigger EXECUTE handler 注册（周期扫描类）──
// P2-a：自 apps/api/src/index.ts 拆出。注册顺序与原 index.ts 逐行一致。
import { logger } from '@dommaker/studio-shared';
import { getStore } from '../core/store.js';


export async function registerScanHandlers(): Promise<void> {
  const { registerExecuteHandler } = await import('../modules/triggers/trigger-action.js');

  // ── Agent Timeout Scan（超时释放 handler）──
  registerExecuteHandler('agent-timeout-scan', async () => {
    const { scanStaleAgentInstances } = await import('../modules/agents/instance-timeout-scan.js');
    const result = await scanStaleAgentInstances(getStore());
    if (result.terminated > 0) logger.info(`[AgentTimeout] Terminated ${result.terminated} stale instances`);
  });

  // ── F5: NEED_INPUT 挂起超时提醒 handler ──
  registerExecuteHandler('workunit-input-reminder-scan', async () => {
    const { scanWaitingForInputReminders } = await import('../modules/workunit/waiting-input.js');
    await scanWaitingForInputReminders();
  });

  // ── #523: 人闸催办与认领滞留 handler（workunit-gate-escalation 触发器，5min）──
  registerExecuteHandler('workunit-gate-escalation-scan', async () => {
    const { scanGateEscalationReminders } = await import('../modules/workunit/gate-escalation.js');
    await scanGateEscalationReminders();
  });

  // ── P0: WorkUnit 执行超时释放 handler（workunit-timeout 触发器）──
  registerExecuteHandler('workunit-timeout-scan', async () => {
    const { scanTimedOutWorkUnits } = await import('../modules/workunit/timeout-release.js');
    await scanTimedOutWorkUnits();
  });

  // ── #183: 派工/评审断链对账 handler（dispatch-reconciliation 触发器，5min）──
  registerExecuteHandler('dispatch-reconciliation-scan', async () => {
    const { reconcileDispatchBreaks } = await import('../modules/agents/dispatch-reconciliation.js');
    await reconcileDispatchBreaks();
  });

  // ── E1 约束进化（vision §6）：每日扫描 handler + review-proposal adapter 注册（#623 正本卡片人审）──
  registerExecuteHandler('evolution-scan', async () => {
    const { getEvolutionService } = await import('../modules/evolution/evolution.service.js');
    const result = await getEvolutionService().runScan();
    if (result.created.length > 0) {
      logger.info(`[Evolution] Daily scan created ${result.created.length} proposal(s)`);
    }
  });
  // 构造单例即注册 review-proposal adapter（kind='evolution'）——保证通用审批端点
  // /review-proposals/evolution/* 在首次扫描前已可分发；频道文本审核 watcher 已随 #623 退役
  try {
    const { getEvolutionService } = await import('../modules/evolution/evolution.service.js');
    getEvolutionService();
  } catch (e) { logger.warn('[Evolution] review adapter registration failed', { error: String(e) }); }

  // ── meeting 路径服务已摘除 ──
}
