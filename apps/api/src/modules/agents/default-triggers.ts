// Default Triggers — 9 system triggers for Agent Network
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';

/** Register the 9 default system triggers */
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
  // #162（T8-E1，#130 决策 8）行为修正：从「周五自动跑」改「周五建单待人确认」——
  // 触发器 CREATE 统一落显式 pending 人闸（见 trigger-action.ts），人工确认后才烧 token。
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

  // 7. inspection-scan: #163（T8-E2，#130 决策 5）EVENT workunit.status_changed →
  //    bug 关闭累计 N 起一轮巡检（N = INSPECTION_SCAN_THRESHOLD 覆盖，默认 3，<=0 关事件触发）。
  //    事件闸（计数+冷却去重）在 trigger-scheduler.handleEvent 分叉（triggers/inspection-scan.ts）：
  //    最近巡检单有待处理机会条目 → 跳过落 studio-events 留痕，频道不打扰。
  //    手动 fire（POST /api/triggers/inspection-scan/fire）不过冷却闸（T9/#131 决策 2）。
  //    建单显式 pending 人闸由 executeCreateAction 统一落地（#162，payload 不带 status）；
  //    tokenBudget = WU 级预算熔断（#162 底座），INSPECTION_TOKEN_BUDGET 覆盖默认 500K。
  //    INSPECTION_SCAN_ENABLED=false 整体关闭。
  registry.registerTrigger({
    id: 'inspection-scan',
    name: 'Inspection scan on bug-close accumulation (T8)',
    condition: { type: 'EVENT', event: 'workunit.status_changed' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: '全仓巡检：扫描代码/文档/配置/测试气味，产出机会清单（问题/建议/预估）。分片扫描、结论即落盘；报告落业务仓 .studio/research/ 并回挂本单，每条机会输出 OPPORTUNITY: 协议行（契约详见 prompt 产出契约段）。',
        assigneeRole: 'studio', // 系统维护任务钉死 studio 角色执行（同 doc-semantic-review 先例）
        metadata: {
          inspection: true,
          tokenBudget: Number(process.env.INSPECTION_TOKEN_BUDGET) > 0
            ? Number(process.env.INSPECTION_TOKEN_BUDGET)
            : 500_000,
        },
      },
    },
    enabled: process.env.INSPECTION_SCAN_ENABLED !== 'false',
    scope: 'system',
  });

  // 8. inspection-scan-schedule: #163（T8-E2，#130 决策 5）SCHEDULE 通道留位、默认关闭——
  //    INSPECTION_SCAN_SCHEDULE_ENABLED=true 启用（cron 由 INSPECTION_SCAN_CRON 覆盖，
  //    默认周一 5:17 错开其他日级任务）；启用后同过冷却闸（冷却挡自动触发含定时）。
  registry.registerTrigger({
    id: 'inspection-scan-schedule',
    name: 'Inspection scan schedule placeholder (T8, default off)',
    condition: { type: 'SCHEDULE', cron: process.env.INSPECTION_SCAN_CRON || '17 5 * * 1' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: '全仓巡检：扫描代码/文档/配置/测试气味，产出机会清单（问题/建议/预估）。分片扫描、结论即落盘；报告落业务仓 .studio/research/ 并回挂本单，每条机会输出 OPPORTUNITY: 协议行（契约详见 prompt 产出契约段）。',
        assigneeRole: 'studio',
        metadata: {
          inspection: true,
          tokenBudget: Number(process.env.INSPECTION_TOKEN_BUDGET) > 0
            ? Number(process.env.INSPECTION_TOKEN_BUDGET)
            : 500_000,
        },
      },
    },
    enabled: process.env.INSPECTION_SCAN_SCHEDULE_ENABLED === 'true',
    scope: 'system',
  });

  // 9. dispatch-reconciliation: #183（#159 + #66 决议①）派工/评审断链 5min 对账扫描
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
