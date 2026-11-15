// ── 事件订阅初始化（workunit.status_changed 等 → 各域消费者）──
// P2-a：自 apps/api/src/index.ts 拆出。调用点固定在 agent-loop 装配内
// （trigger 注册之后、loop 挂载之前），顺序与原 index.ts 逐行一致；
// 各项彼此无依赖，单项失败只 log 不阻断后续（纪律固化在 soft-steps.ts，#686）。
// 表驱动：新增订阅 = EVENT_SUBSCRIPTIONS 加一行。
import { runSoftSteps, type SoftStep } from './soft-steps.js';
import { getStore } from '../core/store.js';

const EVENT_SUBSCRIPTIONS: readonly SoftStep[] = [
  {
    // #716：知识提取 Effect 启动恢复 + 完成 WU transcript 补扫。
    name: 'KnowledgeExtractionRecovery',
    run: async () => {
      const service = (await import('../modules/knowledge/index.js')).getKnowledgeExtractionEffects(getStore());
      await service.recoverPending();
    },
  },
  {
    // AC-4.1: ReviewDispatcher subscribes to workunit.status_changed
    name: 'ReviewDispatcher',
    run: async () => (await import('../modules/agent-loop/index.js')).getReviewDispatcher().subscribeToEvents(),
  },
  {
    // WorkUnit 事件 → SSE（前端 WU 列表/抽屉实时刷新）
    name: 'WorkunitEventsBridge',
    run: async () => (await import('../modules/events/index.js')).initWorkunitEventsBridge(),
  },
  {
    // #169: lock.* 事件（stale 回收/获锁超时）→ Monitor 告警全管线
    // #687：桥归属 ops（消费 Monitor 能力即 Monitor 业务；#683 起随 monitor 并入 ops），events 不再反向依赖
    name: 'LockEventsBridge',
    run: async () => (await import('../modules/ops/index.js')).initLockEventsBridge(),
  },
  {
    // PMO 分析接力：analysis 确认 → 拆 task WU 派工
    name: 'AnalysisHandoff',
    run: async () => (await import('../modules/pmo/index.js')).initAnalysisHandoff(),
  },
  {
    // #464: 无频道 in_review（非 analysis）→ Web「需要处理」收件箱
    name: 'InReviewInbox',
    run: async () => (await import('../modules/workunit/index.js')).initInReviewInbox(),
  },
  {
    // #110 决策落地：decision 确认 → 写探路地图 + 雾全清建 spec 单
    name: 'DecisionResolution',
    run: async () => (await import('../modules/pmo/index.js')).initDecisionResolution(),
  },
  {
    // #112 开图机制：analysis 确认（含待决问题清单）→ 初始化 map + 逐条建 decision 单
    name: 'MapOpening',
    run: async () => (await import('../modules/pmo/index.js')).initMapOpening(),
  },
  {
    // #115 交稿物化：spec 确认（含 TASK 物化清单）→ 批量建 task 单（ac/blockedBy/腿归属）
    name: 'SpecMaterialization',
    run: async () => (await import('../modules/pmo/index.js')).initSpecMaterialization(),
  },
  {
    // #99 WU 收尾批量提取：done → 读归档 transcript → LLM → 角色记忆草稿区（可审计/可熔断）
    name: 'RoleMemoryExtraction',
    run: async () => (await import('../modules/role-memory/index.js')).initWuCompletionExtraction(),
  },
  {
    // skill 度量地基票 B：WU done → transcript 后验扫描 skill 使用痕迹 → skill_used 事件（纯确定性零 LLM）
    name: 'SkillUsageScan',
    run: async () => (await import('../modules/skills/index.js')).initSkillUsageScan(),
  },
  {
    // KE-001 P5（#687 依赖倒置）：session:summary 事件 → 复发模式 Skill 建议
    name: 'SessionPatternSuggest',
    run: async () => (await import('../modules/skills/index.js')).initSessionPatternSuggest(),
  },
  {
    // #143 蒸馏主链路：WU done → 门槛检测（纯计数零 LLM）→ distill_proposal 人审卡
    name: 'DistillLoop',
    run: async () => (await import('../modules/distill/index.js')).initDistillLoop(),
  },
];

export async function initEventSubscriptions(): Promise<void> {
  await runSoftSteps(EVENT_SUBSCRIPTIONS);
}
