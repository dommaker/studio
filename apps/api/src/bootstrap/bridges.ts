// ── 事件订阅初始化（workunit.status_changed 等 → 各域消费者）──
// P2-a：自 apps/api/src/index.ts 拆出。调用点固定在 agent-loop 装配内
// （trigger 注册之后、loop 挂载之前），顺序与原 index.ts 逐行一致；
// 各项彼此无依赖，单个失败只 log 不阻断后续订阅。
import { logger } from '@dommaker/studio-shared';

export async function initEventSubscriptions(): Promise<void> {
  // AC-4.1: ReviewDispatcher subscribes to workunit.status_changed
  try {
    const { getReviewDispatcher } = await import('../modules/agent-loop/index.js');
    getReviewDispatcher().subscribeToEvents();
    logger.info('[ReviewDispatcher] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[ReviewDispatcher] Failed to subscribe', { error: String(e) }); }

  // WorkUnit 事件 → SSE（前端 WU 列表/抽屉实时刷新）
  try {
    const { initWorkunitEventsBridge } = await import('../modules/events/index.js');
    initWorkunitEventsBridge();
  } catch (e) { logger.warn('[Events] WorkUnit events bridge failed', { error: String(e) }); }

  // #169: lock.* 事件（stale 回收/获锁超时）→ Monitor 告警全管线
  try {
    const { initLockEventsBridge } = await import('../modules/events/index.js');
    initLockEventsBridge();
  } catch (e) { logger.warn('[Events] Lock events bridge failed', { error: String(e) }); }

  // PMO 分析接力：analysis 确认 → 拆 task WU 派工
  try {
    const { initAnalysisHandoff } = await import('../modules/pmo/index.js');
    initAnalysisHandoff();
    logger.info('[AnalysisHandoff] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[AnalysisHandoff] Failed to subscribe', { error: String(e) }); }

  // #464: 无频道 in_review（非 analysis）→ Web「需要处理」收件箱
  try {
    const { initInReviewInbox } = await import('../modules/workunit/index.js');
    initInReviewInbox();
    logger.info('[InReviewInbox] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[InReviewInbox] Failed to subscribe', { error: String(e) }); }

  // #110 决策落地：decision 确认 → 写探路地图 + 雾全清建 spec 单
  try {
    const { initDecisionResolution } = await import('../modules/pmo/index.js');
    initDecisionResolution();
    logger.info('[DecisionResolution] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[DecisionResolution] Failed to subscribe', { error: String(e) }); }

  // #112 开图机制：analysis 确认（含待决问题清单）→ 初始化 map + 逐条建 decision 单
  try {
    const { initMapOpening } = await import('../modules/pmo/index.js');
    initMapOpening();
    logger.info('[MapOpening] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[MapOpening] Failed to subscribe', { error: String(e) }); }

  // #115 交稿物化：spec 确认（含 TASK 物化清单）→ 批量建 task 单（ac/blockedBy/腿归属）
  try {
    const { initSpecMaterialization } = await import('../modules/pmo/index.js');
    initSpecMaterialization();
    logger.info('[SpecMaterialization] Subscribed to workunit.status_changed');
  } catch (e) { logger.warn('[SpecMaterialization] Failed to subscribe', { error: String(e) }); }

  // #99 WU 收尾批量提取：done → 读归档 transcript → LLM → 角色记忆草稿区（可审计/可熔断）
  try {
    const { initWuCompletionExtraction } = await import('../modules/role-memory/index.js');
    initWuCompletionExtraction();
    logger.info('[RoleMemory] Completion extraction subscribed (workunit.status_changed → done)');
  } catch (e) { logger.warn('[RoleMemory] Completion extraction init failed', { error: String(e) }); }

  // skill 度量地基票 B：WU done → transcript 后验扫描 skill 使用痕迹 → skill_used 事件（纯确定性零 LLM）
  try {
    const { initSkillUsageScan } = await import('../modules/skills/index.js');
    initSkillUsageScan();
    logger.info('[SkillUsageScan] Subscribed to workunit.status_changed (done → transcript scan)');
  } catch (e) { logger.warn('[SkillUsageScan] Failed to subscribe', { error: String(e) }); }

  // #143 蒸馏主链路：WU done → 门槛检测（纯计数零 LLM）→ distill_proposal 人审卡
  try {
    const { initDistillLoop } = await import('../modules/distill/index.js');
    initDistillLoop();
    logger.info('[Distill] Threshold check subscribed (workunit.status_changed → done)');
  } catch (e) { logger.warn('[Distill] Init failed', { error: String(e) }); }
}
