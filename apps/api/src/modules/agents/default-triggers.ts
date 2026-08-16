// Default Triggers — 7 system triggers for Agent Network
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';

/** Register the 7 default system triggers */
export function registerDefaultTriggers(registry: TriggerScheduler): void {
  // 1. workunit-timeout: SCHEDULE every 5 min → EXECUTE workunit-timeout-scan
  // （P0 修复：原为 UPDATE + 注册时冻结的 timeoutAt 查询，永不命中；改为 EXECUTE handler
  //   每次 tick 现算基准时间，释放回池记 metadata + 频道系统消息，≥3 次转 blocked）
  registry.registerTrigger({
    id: 'workunit-timeout',
    name: 'Release timed-out WorkUnits',
    condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
    action: { type: 'EXECUTE', target: 'workunit-timeout-scan' },
    enabled: true,
    scope: 'system',
  });

  // 2. agent-timeout: SCHEDULE every 2min → EXECUTE agent-timeout-scan
  registry.registerTrigger({
    id: 'agent-timeout',
    name: 'Release timed-out Agent instances',
    condition: { type: 'SCHEDULE', cron: '*/2 * * * *' },
    action: { type: 'EXECUTE', target: 'agent-timeout-scan' },
    enabled: true,
    scope: 'system',
  });

  // 3. okr-metric-sync: SCHEDULE daily 3:47 → EXECUTE okr-metric-sync
  registry.registerTrigger({
    id: 'okr-metric-sync',
    name: 'OKR Metric Sync',
    condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
    action: { type: 'EXECUTE', target: 'okr-metric-sync' },
    scope: 'system',
    enabled: true,
  });

  // 4. workunit-input-reminder: SCHEDULE every 5 min → EXECUTE workunit-input-reminder-scan (F5 双向沟通超时提醒)
  registry.registerTrigger({
    id: 'workunit-input-reminder',
    name: 'Remind on WorkUnits waiting for human input',
    condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
    action: { type: 'EXECUTE', target: 'workunit-input-reminder-scan' },
    enabled: true,
    scope: 'system',
  });

  // 5. evolution-daily-scan: E1 约束进化（vision §6）— 每日扫描 traces/outcomes 产生进化提案，
  // 人在频道审核后生效。EVOLUTION_SCAN_CRON 覆盖时间（默认 4:29，错开其他日级任务）；
  // EVOLUTION_ENABLED=false 关闭（默认 ON 但保守：信号不足时零提案）。
  registry.registerTrigger({
    id: 'evolution-daily-scan',
    name: 'Daily constraint-evolution scan (E1)',
    condition: { type: 'SCHEDULE', cron: process.env.EVOLUTION_SCAN_CRON || '29 4 * * *' },
    action: { type: 'EXECUTE', target: 'evolution-scan' },
    enabled: process.env.EVOLUTION_ENABLED !== 'false',
    scope: 'system',
  });

  // 6. doc-semantic-review: SCHEDULE weekly Friday 9:47 → CREATE WorkUnit for doc semantic review
  // （文档治理闭环 P1，docs/plans/2026-07-doc-governance-loop.md；错开日级 3:17-5:17 与周一 10:23）
  registry.registerTrigger({
    id: 'doc-semantic-review',
    name: 'Weekly doc semantic review',
    condition: { type: 'SCHEDULE', cron: '47 9 * * 5' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: '审查 README.md 与 docs/ 手写文档（清单由 agent 自行定位）同当前代码结构/行为的一致性；产出差异清单（doc/行/文档声称/代码现状/建议）发频道；机械类差异同时给出 sync-docs 重生成命令。',
        assigneeRole: 'studio', // 系统维护任务钉死 studio 角色执行（独占认领，消除竞争；docs/issues/2026-08-03-unattended-token-burn.md）
      },
    },
    enabled: true, // #103 恢复：前置（#90 失败步 outcome 埋点）+ 消防演练（daily-token-budget.test.ts 覆盖熔断→need_input→告警→budget-tripped 全链路）已满足。观察期：恢复后前 4 次运行人工核查 outcome 事件 + 单次 token 消耗，异常即回退 enabled:false
    scope: 'system',
  });

  // 7. dispatch-reconciliation: #183（#159 + #66 决议①）派工/评审断链 5min 对账扫描
  // （timeout-scan 同类；10min 宽限）——analysis 哨兵清单补差集自愈 + review 断链幂等重跑，
  // warning 事件走 #62 告警管线，重试 3 次停跑升 critical
  registry.registerTrigger({
    id: 'dispatch-reconciliation',
    name: 'Reconcile dispatch/review breaks',
    condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
    action: { type: 'EXECUTE', target: 'dispatch-reconciliation-scan' },
    enabled: true,
    scope: 'system',
  });

}
