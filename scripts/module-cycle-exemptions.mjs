/**
 * module-cycle-exemptions — 存量模块级循环依赖豁免清单（#666）
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
 */

// 21 节点环簇：以 workunit 为枢纽的领域互调网（agent-* / channels / pmo / knowledge / requirements 等
// 均经 barrel 互取服务）。成员集精确匹配——任何新模块加入环簇或环簇合并/分裂都会撞门。
// 2026-10-09 #682：通知域合一后 notifications 入簇（alert-notifier 频道 sink → channels barrel，
// channels→workunit→notifications 回路本已存在）；入簇边 = 模块内 alert-notifier → ../channels/index.js。
// 2026-10-09 #683：monitoring/agent-monitor/agent-ops 三面合并为 ops（agent-monitor、monitoring
// 原本在簇，合并后 ops 继承全部跨模块边）；ops 继承 agent-ops 的 ops→auth 边（hashPassword）
// 把 auth 拉入环簇（auth→channels 等回路本已存在）。
const HUB_SCC = [
  'agent-auditor', 'agent-knowledge', 'agent-loop', 'agents',
  'audit-logs', 'auth', 'channels', 'evolution', 'harness', 'knowledge',
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
  mutualPairs: [
    {
      a: 'agent-auditor',
      b: 'audit-logs',
      // auditor-execution 写审计记录；audit-logs/proposal-source 回读 auditor 产出作人审提案来源
      reason: 'auditor 写审计 ↔ audit-logs 回读 auditor 提案来源（proposal-source），同域读写往返；待提案来源改走事件/查询口解耦。',
    },
    {
      a: 'agent-knowledge',
      b: 'knowledge',
      // knowledge-cold-start/maintenance 调知识引擎；knowledge-service/maintenance.routes 回调 agent-knowledge 触发维护
      reason: '知识维护 agent 调引擎 ↔ 引擎/维护路由回调 agent 触发维护任务，生产者-调度互调；待维护触发改走 trigger/事件链解耦。',
    },
    {
      a: 'agent-loop',
      b: 'workunit',
      // agent-loop 全线读写 WU（37 边）；workunit 侧 merge-on-review-pass/routes/service 回调 loop（5 边）
      reason: '决策循环执行 WU ↔ WU 状态机回调 loop（merge-on-review-pass 等）——本平台最核心互耦，agent-loop.ts 拆分（#668）时同步治理。',
    },
    {
      a: 'agent-loop',
      b: 'role-memory',
      // prompt-composer 读角色记忆；role-memory/completion-extraction 回读 loop 的完成判定结构
      reason: 'prompt 装配读角色记忆 ↔ 记忆完成提取回读 loop 产出结构；待提取口下沉 contract/事件解耦。',
    },
    {
      a: 'ops',
      b: 'workunit',
      // monitor 巡检读写 WU（12 边）；workunit/in-review-inbox 回读 monitor 状态（1 边）
      reason: 'monitor 巡检 WU 实例超时 ↔ WU in-review 收件箱回读 monitor（#683：agent-monitor/monitoring/agent-ops 合并为 ops，原 agent-monitor↔workunit 豁免随之更名）；单向化改由 monitor 订阅 WU 事件，随 monitor 域治理回收。',
    },
    {
      a: 'ops',
      b: 'pmo',
      // ops/current-wu-context 经 pmo barrel 解析 WU 归属 PMO；pmo/analysis-handoff 动态 import ops 告警出声
      reason: '#683 合并新成对：监控聚合读 PMO 归属链（current-wu-context→pmo barrel）↔ PMO 分析接力回投 ops 告警管线（analysis-handoff 动态 import）；归属解析应下沉 contract/查询口解耦。',
    },
    {
      a: 'agents',
      b: 'workunit',
      // agents 实例/token 用量关联 WU；workunit merge-on-review-pass/routes 回读 agents 实例
      reason: 'agent 实例/用量挂在 WU 上 ↔ WU 合并链路回查实例；关联键改经 contract 类型 + 查询口解耦。',
    },
    {
      a: 'agents',
      b: 'knowledge',
      // agents/session-summary 写知识；knowledge 侧 extractor/routes/service 回读 agents 会话摘要
      reason: '会话摘要沉淀知识 ↔ 知识提取回读 agents 会话；同属沉淀链读写往返，待沉淀改走事件总线解耦。',
    },
    {
      a: 'channels',
      b: 'workunit',
      // channels 派单/消息路由建改 WU（11 边）；workunit CRUD/路由回发频道消息（10 边）
      reason: '频道派单建 WU ↔ WU 状态回播频道消息——双向沟通（F5）设计使然；回播侧应改走通知口/事件，随 channels 域治理回收。',
    },
    {
      a: 'channels',
      b: 'pmo',
      // channels 推导当前 PMO/候选；pmo 交付通知/开图回发频道
      reason: '频道推导当前 PMO ↔ PMO 交付通知/开图回发频道；PMO→channels 应改走通知口解耦。',
    },
    {
      a: 'channels',
      b: 'knowledge',
      // channels 消息服务写知识；knowledge 提取器/挖掘回读频道消息
      reason: '频道消息沉淀知识 ↔ 知识挖掘回读频道原料，读写往返；挖掘侧应走 transcripts/事件原料而非直读 channels。',
    },
    {
      a: 'pmo',
      b: 'workunit',
      // pmo 交付/决策/进度汇总读写 WU（25 边）；workunit 路由/服务回读 pmo 归属（4 边）
      reason: 'PMO 以 WU 汇总状态 ↔ WU 回查 PMO 归属分支；归属键应下沉 contract，随 workunit.service 拆分（#672）治理。',
    },
    {
      a: 'pmo',
      b: 'requirements',
      // pmo 交付/证据/进度读 REQ；requirements 侧 channel-req-pmo/branch-resolver 回查 PMO
      reason: 'PMO 汇总 REQ 交付 ↔ REQ 归属/分支解析回查 PMO，编号体系（vision §5.3）双向解析使然；解析器应单向化到 requirements 侧。',
    },
  ],
};
