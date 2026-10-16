/**
 * module-cycle-exemptions — 存量模块级循环依赖豁免清单（#666；#695 砍掉互耦对细粒度层）
 *
 * scripts/check-module-cycles.mjs 的比对基准。规则：
 * - 每条必须带 reason（架构成因 + 治理去向），改动本文件须在 commit message 说明；
 * - 实际环与清单任一侧漂移即 CI 红：新增环拆依赖或补豁免，环清零后必须回收对应豁免（stale 也 fail）。
 *
 * 现状（2026-10-09 #683 更新）：33 个模块中 21 个落在同一个 SCC——
 * 根因是「领域服务经对方 barrel（index.ts）互调」是本平台的主流协作形态
 * （WU 状态机贯穿 channels/pmo/requirements/knowledge/agents 各域），
 * 全部边均走公共面 barrel、无深路径；清零依赖 Phase 3 巨型文件拆分（#668-#672）
 * 与后续领域分层，非单票可消化，故按票决议走显式豁免路线。
 *
 * #695（2026-10-12）：删除 mutualPairs 逐对豁免层（原 13 对，逐对写 reason 边际价值低），
 * 「不扩大」由 SCC 成员集精确匹配 + stale 自检兜住——簇内新增直连互耦若不改变 SCC
 * 成员集则不再单独告警，簇扩大/合并/分裂仍撞门。
 */

// 21 节点环簇：以 workunit 为枢纽的领域互调网（agent-* / channels / pmo / knowledge / requirements 等
// 均经 barrel 互取服务）。成员集精确匹配——任何新模块加入环簇或环簇合并/分裂都会撞门。
// 2026-10-09 #682：通知域合一后 notifications 入簇（alert-notifier 频道 sink → channels barrel，
// channels→workunit→notifications 回路本已存在）；入簇边 = 模块内 alert-notifier → ../channels/index.js。
// 2026-10-09 #683：monitoring/agent-monitor/agent-ops 三面合并为 ops（agent-monitor、monitoring
// 原本在簇，合并后 ops 继承全部跨模块边）；ops 继承 agent-ops 的 ops→auth 边（hashPassword）
// 把 auth 拉入环簇（auth→channels 等回路本已存在）。
// 2026-10-16 Phase 5 第一刀 #1：auth→audit-logs 改装配期 DI（auth/audit-sink.ts，
// bootstrap/module-sinks.ts 注入实现），auth 的出簇边清零退出 SCC（21→20）。
const HUB_SCC = [
  'agent-auditor', 'agent-knowledge', 'agent-loop', 'agents',
  'audit-logs', 'channels', 'evolution', 'harness', 'knowledge',
  'mcp', 'notifications', 'ops', 'pmo', 'requirements',
  'review-proposal', 'role-memory', 'skills', 'triage', 'triggers',
  'workunit',
];

export default {
  sccs: [
    {
      modules: HUB_SCC,
      reason: '领域服务经 barrel 互调的主流协作形态（WU 状态机为枢纽），清零依赖 Phase 3 拆分（#668-#672）后的领域分层；门的作用是冻结成员集、阻止环簇扩大。',
    },
  ],
};
