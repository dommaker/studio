// Default Triggers — 10 system triggers for Agent Network
import { TriggerScheduler } from '../triggers/trigger-scheduler.js';
import type { TriggerConfig } from '../triggers/trigger.types.js';

/** Register the 10 default system triggers */
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

  // 3. knowledge-quality-audit: SCHEDULE daily 3:17 → CREATE WorkUnit for semantic audit
  registry.registerTrigger({
    id: 'knowledge-quality-audit',
    name: 'Daily knowledge quality semantic audit',
    condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Run knowledge-quality-skill: audit semantic quality of ~/.studio/knowledge/. Check D1-D6 dimensions. Archive low_quality noise entries. Merge fragment clusters. Rebuild _index.md after convergence.',
      },
    },
    enabled: false, // 2026-08-03 停用：LLM 日任务无人值守空烧且全部 blocked 零产出（docs/issues/2026-08-03-unattended-token-burn.md），B/C 档修复后评估恢复
    scope: 'system',
  });

  // 4. okr-metric-sync: SCHEDULE daily 3:47 → EXECUTE okr-metric-sync
  registry.registerTrigger({
    id: 'okr-metric-sync',
    name: 'OKR Metric Sync',
    condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
    action: { type: 'EXECUTE', target: 'okr-metric-sync' },
    scope: 'system',
    enabled: true,
  });

  // 5. session-knowledge-extraction: SCHEDULE daily 4:17 → CREATE WorkUnit for session extraction
  registry.registerTrigger({
    id: 'session-knowledge-extraction',
    name: 'Daily session knowledge extraction',
    condition: { type: 'SCHEDULE', cron: '17 4 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Scan ~/.studio/data/sessions/ for unprocessed JSONL files. Extract knowledge using knowledge-extraction skill. Mark processed files with .done suffix.',
      },
    },
    enabled: false, // 2026-08-03 停用：LLM 日任务无人值守空烧且全部 blocked 零产出（docs/issues/2026-08-03-unattended-token-burn.md），B/C 档修复后评估恢复
    scope: 'system',
  });

  // 6. zero-consumption-audit: SCHEDULE daily 5:17 → CREATE WorkUnit for zero-consumption review
  registry.registerTrigger({
    id: 'zero-consumption-audit',
    name: 'Daily zero-consumption knowledge audit',
    condition: { type: 'SCHEDULE', cron: '17 5 * * *' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Scan ~/.studio/knowledge/ for entries with empty referencedBy. Output audit report to ~/.studio/data/knowledge-consumption-audit.md with entry list, creation dates, and recommendations (keep/archive).',
      },
    },
    enabled: false, // 2026-08-03 停用：LLM 日任务无人值守空烧且全部 blocked 零产出（docs/issues/2026-08-03-unattended-token-burn.md），B/C 档修复后评估恢复
    scope: 'system',
  });

  // 7. knowledge-synthesis: SCHEDULE weekly Monday 10:23 → CREATE WorkUnit for Skill proposal
  registry.registerTrigger({
    id: 'knowledge-synthesis',
    name: 'Weekly knowledge synthesis and Skill proposal',
    condition: { type: 'SCHEDULE', cron: '23 10 * * 1' },
    action: {
      type: 'CREATE',
      target: 'WorkUnit',
      payload: {
        type: 'analysis',
        scope: 'Execute knowledge-synthesis-skill: scan recent knowledge entries for semantic patterns. If 3+ entries share an underlying pattern, propose a new Skill via skill-creator.',
      },
    },
    enabled: false, // 2026-08-03 停用：8/3 同样 blocked 空烧，待 blocked 问题修复后评估恢复（docs/issues/2026-08-03-unattended-token-burn.md）
    scope: 'system',
  });

  // 8. workunit-input-reminder: SCHEDULE every 5 min → EXECUTE workunit-input-reminder-scan (F5 双向沟通超时提醒)
  registry.registerTrigger({
    id: 'workunit-input-reminder',
    name: 'Remind on WorkUnits waiting for human input',
    condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
    action: { type: 'EXECUTE', target: 'workunit-input-reminder-scan' },
    enabled: true,
    scope: 'system',
  });

  // 9. evolution-daily-scan: E1 约束进化（vision §6）— 每日扫描 traces/outcomes 产生进化提案，
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

  // 10. doc-semantic-review: SCHEDULE weekly Friday 9:47 → CREATE WorkUnit for doc semantic review
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
      },
    },
    enabled: true,
    scope: 'system',
  });

}

/** Get default trigger configs (for testing) */
export function getDefaultTriggerConfigs(): TriggerConfig[] {
  return [
    {
      id: 'workunit-timeout',
      name: 'Release timed-out WorkUnits',
      condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
      action: { type: 'EXECUTE', target: 'workunit-timeout-scan' },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'agent-timeout',
      name: 'Release timed-out Agent instances',
      condition: { type: 'SCHEDULE', cron: '*/2 * * * *' },
      action: { type: 'EXECUTE', target: 'agent-timeout-scan' },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'knowledge-quality-audit',
      name: 'Daily knowledge quality semantic audit',
      condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Run knowledge-quality-skill: audit semantic quality of ~/.studio/knowledge/. Check D1-D6 dimensions. Archive low_quality noise entries. Merge fragment clusters. Rebuild _index.md after convergence.',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'okr-metric-sync',
      name: 'OKR Metric Sync',
      condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
      action: { type: 'EXECUTE', target: 'okr-metric-sync' },
      scope: 'system',
      enabled: true,
    },
    {
      id: 'session-knowledge-extraction',
      name: 'Daily session knowledge extraction',
      condition: { type: 'SCHEDULE', cron: '17 4 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Scan ~/.studio/data/sessions/ for unprocessed JSONL files. Extract knowledge using knowledge-extraction skill. Mark processed files with .done suffix.',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'zero-consumption-audit',
      name: 'Daily zero-consumption knowledge audit',
      condition: { type: 'SCHEDULE', cron: '17 5 * * *' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Scan ~/.studio/knowledge/ for entries with empty referencedBy. Output audit report to ~/.studio/data/knowledge-consumption-audit.md with entry list, creation dates, and recommendations (keep/archive).',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'knowledge-synthesis',
      name: 'Weekly knowledge synthesis and Skill proposal',
      condition: { type: 'SCHEDULE', cron: '23 10 * * 1' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: 'Execute knowledge-synthesis-skill: scan recent knowledge entries for semantic patterns. If 3+ entries share an underlying pattern, propose a new Skill via skill-creator.',
        },
      },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'workunit-input-reminder',
      name: 'Remind on WorkUnits waiting for human input',
      condition: { type: 'SCHEDULE', cron: '*/5 * * * *' },
      action: { type: 'EXECUTE', target: 'workunit-input-reminder-scan' },
      enabled: true,
      scope: 'system',
    },
    {
      id: 'evolution-daily-scan',
      name: 'Daily constraint-evolution scan (E1)',
      condition: { type: 'SCHEDULE', cron: process.env.EVOLUTION_SCAN_CRON || '29 4 * * *' },
      action: { type: 'EXECUTE', target: 'evolution-scan' },
      enabled: process.env.EVOLUTION_ENABLED !== 'false',
      scope: 'system',
    },
    {
      id: 'doc-semantic-review',
      name: 'Weekly doc semantic review',
      condition: { type: 'SCHEDULE', cron: '47 9 * * 5' },
      action: {
        type: 'CREATE',
        target: 'WorkUnit',
        payload: {
          type: 'analysis',
          scope: '审查 README.md 与 docs/ 手写文档（清单由 agent 自行定位）同当前代码结构/行为的一致性；产出差异清单（doc/行/文档声称/代码现状/建议）发频道；机械类差异同时给出 sync-docs 重生成命令。',
        },
      },
      enabled: true,
      scope: 'system',
    },
  ];
}
