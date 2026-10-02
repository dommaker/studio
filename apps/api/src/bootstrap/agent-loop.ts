// ── AS-026: AgentLoop per AgentProfile ──
// P2-a：自 apps/api/src/index.ts 拆出。块内顺序与原 index.ts 逐行一致：
// 内置角色幂等创建 → provider 回填 → scheduler.start → （非 standby）注册系统触发器
// → 事件订阅（bridges.initEventSubscriptions）→ 挂载 loop → assignee 自检。
import { logger } from '@dommaker/studio-shared';
import { initEventSubscriptions } from './bridges.js';
import { getStore } from '../core/store.js';


export async function startAgentLoops(): Promise<void> {
  try {
    const { agentLoopRegistry } = await import('../modules/agent-loop/index.js');
    const { registerDefaultTriggers } = await import('../modules/agents/index.js');
    const { getTriggerScheduler } = await import('../modules/triggers/index.js');
    const { ensureStudioProfile } = await import('../modules/agents/index.js');

    const fileStore = getStore();
    // AC-1.1: 启动时幂等创建内置 studio 角色（系统任务执行身份）
    try {
      await ensureStudioProfile(fileStore);
    } catch (e) { logger.warn('[StudioRole] ensureStudioProfile failed', { error: String(e) }); }
    // F1（2026-07-28 分析文档）: 回填存量角色空 provider（幂等;不含 studio）。
    // 内置三角色 seed（B4a 决策 D7）已随 reviewer/pm 解锚退役（F4/F5）——
    // 角色创建走用户入口（FirstRoleSetupModal / 角色向导 / preset 模板），不再系统 seed。
    try {
      const { backfillProfileProviders } = await import('../modules/agents/index.js');
      const stamped = await backfillProfileProviders(fileStore);
      if (stamped > 0) logger.info('[DefaultProvider] Startup backfill done', { stamped });
    } catch (e) { logger.warn('[DefaultProvider] Backfill failed', { error: String(e) }); }
    const profiles = await fileStore.listProfiles({ status: 'active' });
    const scheduler = getTriggerScheduler(); // Singleton — shared with trigger.routes.ts
    scheduler.start(); // Start tick interval for SCHEDULE triggers (workunit-timeout, poll-fallback)

    // 2026-07-30 走查修复：同一 ~/.studio 多实例（dev/prod 并存）时，只允许一个实例
    // 挂载 agent loop + 注册系统触发器 —— 否则同 profile 被重复挂载（认领竞争、频道重复
    // 回复、定时 WU 重复创建）。STUDIO_AGENT_LOOP_ENABLED=false 的实例 standby：
    // 仍提供 REST/UI 与事件订阅（ReviewDispatcher/AnalysisHandoff 有幂等哨兵，状态变更
    // 由谁发起就在谁进程内触发，故两侧都保留），但不认领、不发言、不建定时 WU。
    const agentLoopEnabled = process.env.STUDIO_AGENT_LOOP_ENABLED !== 'false';
    if (!agentLoopEnabled) {
      logger.info('[AgentLoop] STUDIO_AGENT_LOOP_ENABLED=false — 本实例 standby：不挂载 loop、不注册系统触发器');
    }
    if (agentLoopEnabled) {
      registerDefaultTriggers(scheduler);

      // F1: profile 生命周期事件（create/activate/deactivate/delete）→ 动态挂载/卸载
      agentLoopRegistry.subscribeToEvents();
    }

    // 事件订阅（ReviewDispatcher → 各域 bridge/rollup）——standby 实例同样保留
    await initEventSubscriptions();

    if (agentLoopEnabled) {
      for (const profile of profiles) {
        const entry = await agentLoopRegistry.mount(profile);
        if (entry.status === 'running') {
          logger.info(`[AgentLoop] Started for profile ${profile.name}`);
        }
      }
      if (profiles.length === 0) {
        logger.info('[AgentLoop] No active profiles found, skipping auto-start');
      }

      // 2026-09-10 启动自检：CREATE 类 trigger 的 assigneeRole 必须解析到 loop running 的角色，
      // 否则建出的指名 WU 是结构性死单（doc-semantic-review 滞留 143h 事故）。
      // 仅 agentLoopEnabled 实例执行（standby 实例不挂 loop，自检必然误报）。
      try {
        const { checkTriggerAssignees } = await import('../modules/triggers/index.js');
        const problems = await checkTriggerAssignees(
          scheduler.getStates().map(s => s.config),
          { fileStore, getLoopEntry: (id) => agentLoopRegistry.get(id) },
        );
        for (const p of problems) {
          logger.error(`[TriggerAssigneeCheck] trigger "${p.triggerId}" assigneeRole "${p.assigneeRole}": ${p.reason}`);
        }
        if (problems.length === 0) {
          logger.info('[TriggerAssigneeCheck] All named trigger assignees have running loops');
        }
      } catch (e) { logger.warn('[TriggerAssigneeCheck] Failed', { error: String(e) }); }
    }
  } catch (e) { logger.warn('[AgentLoop] Failed to start', { error: String(e) }); }
}

export async function sweepEmptyAgentDirs(): Promise<void> {
  // ── #363: 存量空实例目录一次性清扫（启动时跑，幂等）──
  // 历史死实例目录只删 state.json 不删目录 → 空目录无界累积；闭环后此处每启动
  // 重跑无副作用（无空目录时 removed=0）。
  try {
    const swept = await getStore().sweepEmptyAgentDirs();
    if (swept.removed > 0) logger.info(`[Startup] Swept ${swept.removed} empty agent instance dir(s) (#363)`);
  } catch (e) { logger.warn('Empty agent dir sweep failed (non-blocking)', { error: String(e) }); }
}
