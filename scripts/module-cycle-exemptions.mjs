/**
 * module-cycle-exemptions — 存量模块级循环依赖豁免清单（#666；#695 砍掉互耦对细粒度层）
 *
 * scripts/check-module-cycles.mjs 的比对基准。规则：
 * - 每条必须带 reason（架构成因 + 治理去向），改动本文件须在 commit message 说明；
 * - 实际环与清单任一侧漂移即 CI 红：新增环拆依赖或补豁免，环清零后必须回收对应豁免（stale 也 fail）。
 *
 * 现状（ARCH-04）：32 个模块中 16 个落在同一个 SCC（WorkUnit、Requirements 已退出）——
 * 根因是「领域服务经对方 barrel（index.ts）互调」是本平台的主流协作形态，
 * 全部边均走公共面 barrel、无深路径；清零依赖后续领域分层，非单票可消化，
 * 故按票决议走显式豁免路线。
 *
 * #695（2026-10-12）：删除 mutualPairs 逐对豁免层；ARCH-02 起以 SCC 成员集 +
 * intra-SCC 边双层冻结补齐簇内新增边盲区，簇扩大/合并/分裂及簇内新增互耦均撞门。
 * ARCH-04：Requirements 只经 ProjectReadPort 读 PMO，退出 SCC（17→16），相关簇内边同步回收。
 */

// 16 节点环簇：WorkUnit/Requirements 端口化退出后剩余的领域互调网。成员集与边均精确匹配。
// 2026-10-09 #682：通知域合一后 notifications 入簇（alert-notifier 频道 sink → channels barrel，
// channels→workunit→notifications 回路本已存在）；入簇边 = 模块内 alert-notifier → ../channels/index.js。
// 2026-10-09 #683：monitoring/agent-monitor/agent-ops 三面合并为 ops（agent-monitor、monitoring
// 原本在簇，合并后 ops 继承全部跨模块边）；ops 继承 agent-ops 的 ops→auth 边（hashPassword）
// 把 auth 拉入环簇（auth→channels 等回路本已存在）。
// 2026-10-16 Phase 5 第一刀 #1：auth→audit-logs 改装配期 DI（auth/audit-sink.ts，
// bootstrap/module-sinks.ts 注入实现），auth 的出簇边清零退出 SCC（21→20）。
// 2026-10-16 Phase 5 第一刀 #2：notifications→channels 同手法（alert-notifier 的
// AlertChannelPoster 注册口 + 装配注入），notifications 出簇边清零退出 SCC（20→19）。
// 2026-10-16 Phase 5 第一刀 #3：review-proposal→channels 同手法（card.ts 的
// ChannelCardPoster 注册口 + 装配注入，动态 import 临时招退役），退出 SCC（19→18）。
const HUB_SCC = [
  'agent-auditor', 'agent-knowledge', 'agent-loop', 'agents',
  'audit-logs', 'channels', 'evolution', 'harness', 'knowledge',
  'mcp', 'ops', 'pmo', 'role-memory', 'skills', 'triage', 'triggers',
];

// ARCH-02：除 SCC 成员集外同时冻结簇内边；成员不变的新互耦也会撞门。
const HUB_EDGES = [
  'agent-auditor->audit-logs', 'agent-auditor->channels', 'agent-auditor->knowledge',
  'agent-auditor->pmo', 'agent-auditor->skills', 'agent-auditor->triage',
  'agent-knowledge->agents', 'agent-knowledge->knowledge',
  'agent-loop->agents', 'agent-loop->channels', 'agent-loop->knowledge',
  'agent-loop->ops', 'agent-loop->pmo',
  'agent-loop->role-memory', 'agent-loop->skills', 'agent-loop->triggers',
  'agents->knowledge', 'agents->triggers',
  'audit-logs->agent-auditor', 'audit-logs->evolution', 'audit-logs->knowledge',
  'audit-logs->role-memory', 'audit-logs->skills',
  'channels->agents', 'channels->audit-logs', 'channels->knowledge', 'channels->pmo',
  'evolution->channels', 'evolution->knowledge',
  'harness->evolution', 'harness->knowledge',
  'knowledge->agent-knowledge', 'knowledge->agents', 'knowledge->channels', 'knowledge->skills',
  'mcp->harness', 'mcp->knowledge', 'mcp->pmo', 'mcp->skills',
  'ops->agent-knowledge', 'ops->agents', 'ops->channels', 'ops->knowledge',
  'ops->mcp', 'ops->pmo', 'ops->triage',
  'pmo->agents', 'pmo->channels', 'pmo->ops',
  'role-memory->agent-loop', 'role-memory->agents',
  'skills->agents', 'skills->channels',
  'triage->knowledge', 'triggers->audit-logs',
];

export default {
  sccs: [
    {
      modules: HUB_SCC,
      edges: HUB_EDGES,
      reason: 'ARCH-04 后 Requirements 退出环簇（17→16）；冻结剩余 SCC 成员与簇内边，新增成员或新增互耦均失败。',
    },
  ],
};
