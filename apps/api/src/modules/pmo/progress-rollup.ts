/**
 * B3a 工程归属链（决策 D2）：PMO 项目进度回写。
 *
 * 订阅 workunit.status_changed：变更 WU 关联的 Requirement 挂了 projectId 时，
 * 按该项目下全部 Requirement 关联 WU 的完结比例重算 project.progress；
 * 全部完结 → 证据感知翻转（2026-07-30 根因修复，此前不看交付证据直接 completed）：
 *   - 证据齐（evidence-summary 共享口径 deliverable）→ completed；
 *   - 证据有缺口 → active/pending 项目置 in_review（活干完了，等证据验收），
 *     已是 in_review 则不动；completed/cancelled 项目入口即跳过（不回退）。
 *   幂等补写证据（l2/l3 后补）不产生状态迁移事件，靠 GET /pmo/project/:id
 *   读取时的 best-effort 重算（routes.ts:107）纠偏翻 completed。
 * analysis 派生链（analysis-handoff）的 task WU 无 reqId，仅 metadata.pmoId
 * 溯源——Requirement 链路拿不到关联 WU 时回退按 pmoId 归属，口径不变。
 *
 * 完结口径与 REQ 状态汇总一致（TERMINAL_WORKUNIT_STATUSES：in_review 视同工作完成）。
 * progress 语义 = 「活干完了多少」，与证据口径无关。
 * best-effort：任何失败仅记日志，不阻断事件主流程。
 *
 * #113 T7：显式多腿项目（resolveDeliveries > 1）走逐腿状态机——腿状态独立演进
 * （LEG_STATUS：pending→active→in_review→completed，delivered 终态不回写，
 * 零 WU 腿不动且不阻断），腿状态回写 project.deliveries；项目整体翻转条件 =
 * 全部腿 completed/delivered（零 WU 腿视为满足）。单腿项目不走腿路径，行为不变。
 *
 * #115 T9 派生链未落定不翻 completed（e2e 走查根因修复）：analysis/spec 单 done 事件
 * 触发本回写时，派生订阅器（analysis-handoff / map-opening / decision-resolution /
 * spec-materialization，启动挂载序晚于本订阅）尚未运行——派生哨兵未落、下游 WU 未建，
 * 此刻「全部完结」是假相。若翻 completed，本函数 early-return 不回退，后派生的在途
 * WU 永远无法再推动状态（探路链项目卡在 completed、腿状态冻结）。判定：
 *   ① 项目有 map 且 specSpawnedAt 未落（探路链未成文）；
 *   ② 已完结 analysis WU 缺 analysisTasksSpawnedAt（接力/开图未处理）；
 *   ③ 已完结 spec WU 缺 specTasksSpawnedAt（交稿物化未处理）。
 * 命中即跳过本次 completed/in_review 翻转（progress 照写），待派生落定后的下一事件
 * 或 GET /project/:id 读取时重算再评估。
 */
import { eventBus, FileStore, logger, createSettledTracker, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { RequirementService, TERMINAL_WORKUNIT_STATUSES } from '../requirements/requirement.service.js';
import { projectService, resolveDeliveries, LEG_STATUS, PROJECT_STATUS, type DeliveryLeg, type ProjectData } from './project.service.js';
import { parseWuMetaPmoId, selectProjectSnapshots, summarizeEvidence, partitionSnapshotsByLeg } from './evidence-summary.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';

// 兼容现有引用方（原定义已移至 evidence-summary.ts 共享口径）
export { parseWuMetaPmoId };

/**
 * 挂载进度回写订阅，返回解绑函数（测试用）。
 * 生产环境在 API 启动时调用一次（见 apps/api/src/index.ts）。
 */
export function initPmoProgressRollup(fileStore?: FileStore): () => void {
  const handler = (payload: { workunit?: { reqId?: string | null; metadata?: string | null } }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    if (wu.reqId) {
      rollupTracker.track(syncProjectProgressByReqId(wu.reqId, fileStore).catch(err =>
        logger.warn('[PMO] Progress rollup failed (non-blocking)', { reqId: wu.reqId, error: String(err) })
      ));
      return;
    }
    // analysis 派生链：无 reqId，经 metadata.pmoId 找到项目再 rollup
    const pmoId = parseWuMetaPmoId(wu.metadata);
    if (!pmoId) return;
    rollupTracker.track(syncProjectProgress(pmoId, fileStore).catch(err =>
      logger.warn('[PMO] Progress rollup failed (non-blocking)', { projectId: pmoId, error: String(err) })
    ));
  };
  eventBus.subscribe('workunit.status_changed', handler);
  return () => eventBus.unsubscribe('workunit.status_changed', handler);
}

/**
 * #158 测试可观测性（纯增量，不改变发布/消费行为）：登记在途回写 promise。
 * 事件订阅是 fire-and-forget，publish 同步触发 handler 后回写链路仍在异步推进，
 * 测试侧原本只能盲等（waitFor 轮询）——全量负载下事件循环饥饿会吃满超时预算（偶发红）。
 * #228：实现归并到 studio-shared 的 createSettledTracker（原三处复制之一）。
 */
const rollupTracker = createSettledTracker();

/**
 * 等待当前已触发的全部进度回写落定（测试用确定性信号，替代 waitFor 盲等）。
 * publish 在 transitionStatus await 链内同步发射（workunit.service.ts），故
 * await transitionStatus 返回时在途回写必已登记，await 本函数即等到回写真正完成。
 */
export async function waitForPmoProgressRollupSettled(): Promise<void> {
  await rollupTracker.waitForSettled();
}

/** WU 状态变更入口：经其 reqId 找到挂接的 PMO 项目并重算进度 */
export async function syncProjectProgressByReqId(reqId: string, fileStore?: FileStore): Promise<void> {
  const reqService = new RequirementService(fileStore);
  const requirement = await reqService.get(reqId);
  if (!requirement?.projectId) return;
  await syncProjectProgress(requirement.projectId, fileStore);
}

/**
 * 同一项目的回写串行化：status_changed 事件是 fire-and-forget，相邻两次迁移
 * （如 WU in_review → done）会并发触发回写——不串行时慢到的 in_review 写可能
 * 覆盖先到的 completed。按 projectId 链式排队，前序失败不阻断后续。
 */
const syncChains = new Map<string, Promise<void>>();

/**
 * 重算单个 PMO 项目进度：该项目下全部 Requirement 关联 WU 的完结比例。
 * Requirement 链路拿不到关联 WU 时回退按 metadata.pmoId 归属统计（analysis 派生链），口径不变。
 * completed/cancelled 项目不再回写（不回退）；无关联 WU 时不动作。
 * 全部完结时按证据翻转：deliverable → completed；否则 active/pending → in_review（等证据验收）。
 */
export function syncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  const run = (syncChains.get(projectId) ?? Promise.resolve())
    .catch(() => { /* 前序失败不阻断后续 */ })
    .then(() => doSyncProjectProgress(projectId, fileStore));
  syncChains.set(projectId, run);
  // 链尾回收，避免 Map 随项目数无限增长
  const cleanup = () => { if (syncChains.get(projectId) === run) syncChains.delete(projectId); };
  run.then(cleanup, cleanup);
  return run;
}

/**
 * #115 T9：派生链未落定判定（见文件头）。命中 → 本次不得翻 completed/in_review
 * （「全部完结」是派生前的假相），progress 照写。
 */
export function derivationPending(project: ProjectData, snapshots: WorkUnitSnapshot[]): boolean {
  // ① 探路链未成文（map 存在则 spec 成文单必由 decision-resolution 派生）
  if (project.map && !project.map.specSpawnedAt) return true;
  return snapshots.some(s => {
    if (!TERMINAL_WORKUNIT_STATUSES.includes(s.status)) return false;
    const meta = parseWuMetadata(s.metadata);
    // ② analysis 接力/开图未处理（analysis-handoff 对 done 恒落哨兵）
    if (s.type === 'analysis' && !meta.analysisTasksSpawnedAt) return true;
    // ③ spec 交稿物化未处理（spec-materialization 对 done 恒落哨兵）
    if (s.type === 'spec' && !meta.specTasksSpawnedAt) return true;
    return false;
  });
}

async function doSyncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) return;
  if (project.status === PROJECT_STATUS.COMPLETED || project.status === PROJECT_STATUS.CANCELLED) return;

  const fs = fileStore ?? new FileStore();
  const reqService = new RequirementService(fs);
  const snapshots = selectProjectSnapshots(projectId, await reqService.list(), await fs.getIndex());
  if (snapshots.length === 0) return;

  // #113 T7：显式多腿项目走逐腿状态机（腿状态独立演进 + 全腿完结才翻整体）；
  // 单腿（无 deliveries / 合成单腿）保持下方现状路径逐字节一致。
  const legs = resolveDeliveries(project);
  if (legs.length > 1) {
    await doSyncMultiLegProgress(project, legs, snapshots);
    return;
  }

  const done = snapshots.filter(s => TERMINAL_WORKUNIT_STATUSES.includes(s.status)).length;
  const progress = Math.round((done / snapshots.length) * 100);

  // #115：派生链未落定（假相全完结）不翻状态，progress 照写
  if (done === snapshots.length && derivationPending(project, snapshots)) {
    if (progress !== project.progress) await projectService.update(projectId, { progress });
    logger.info('[PMO] Derivation pending — skip completion flip', { projectId, workUnitCount: snapshots.length });
    return;
  }

  if (done === snapshots.length) {
    const summary = summarizeEvidence(snapshots);
    if (summary.deliverable) {
      // 证据齐 → completed（skipValidation 系统汇总直写，自动带 completedAt 与 progress=100）
      await projectService.updateStatus(projectId, PROJECT_STATUS.COMPLETED, true);
      logger.info('[PMO] Project completed (all requirement workunits done)', {
        projectId,
        workUnitCount: snapshots.length,
      });
    } else if (project.status === PROJECT_STATUS.ACTIVE || project.status === PROJECT_STATUS.PENDING) {
      // 活干完了但证据有缺口 → in_review（等证据验收），不冒充 completed；
      // 已是 in_review 则不动。幂等补写证据不产生状态事件，
      // 靠 GET /pmo/project/:id 读取时的 best-effort 重算纠偏翻 completed。
      if (progress !== project.progress) await projectService.update(projectId, { progress });
      await projectService.updateStatus(projectId, PROJECT_STATUS.IN_REVIEW, true);
      logger.info('[PMO] Project in_review (work finished, evidence gaps)', {
        projectId,
        workUnitCount: snapshots.length,
        l1Missing: summary.l1Missing.length,
        l2Missing: summary.l2Missing.length,
        l3Missing: summary.l3Missing.length,
      });
    }
  } else if (progress !== project.progress) {
    await projectService.update(projectId, { progress });
    logger.info('[PMO] Project progress updated', { projectId, progress, done, total: snapshots.length });
  }
}

/**
 * #113 T7 多腿逐腿状态机（仅显式多腿项目进入；串行化由 syncChains 保证，与单腿同链）：
 *   - 腿 WU 集 = 本腿命中 + 未分腿公共 WU（evidence-summary 保守口径）；
 *   - 腿内全完结：证据齐 → 腿 completed，证据缺口 → 腿 in_review；
 *     有在途且腿仍 pending → 腿 active；delivered 腿不回写（终态）；零 WU 腿状态不动；
 *   - 项目整体：progress 口径不变（全部 WU 完结比例）；翻转条件 = 全部腿
 *     completed/delivered（零 WU 腿视为满足）→ completed，否则同单腿语义置 in_review。
 */
async function doSyncMultiLegProgress(
  project: ProjectData,
  legs: DeliveryLeg[],
  snapshots: WorkUnitSnapshot[],
): Promise<void> {
  const projectId = project.id;
  const isTerminal = (s: WorkUnitSnapshot) => TERMINAL_WORKUNIT_STATUSES.includes(s.status);
  const done = snapshots.filter(isTerminal).length;
  const progress = Math.round((done / snapshots.length) * 100);

  // #115：派生链未落定（假相全完结）——腿状态与项目状态都不翻（腿 completed 同样
  // 是假相），progress 照写；派生落定后的下一事件再评估
  if (done === snapshots.length && derivationPending(project, snapshots)) {
    if (progress !== project.progress) await projectService.update(projectId, { progress });
    logger.info('[PMO] Derivation pending — skip leg/completion flip (multi-leg)', { projectId, workUnitCount: snapshots.length });
    return;
  }

  const { perLeg, shared } = partitionSnapshotsByLeg(legs, snapshots);
  const legSnapsList = legs.map((_, i) => [...perLeg[i], ...shared]);

  const newLegs = legs.map((leg, i) => {
    const snaps = legSnapsList[i];
    if (leg.status === LEG_STATUS.DELIVERED || snaps.length === 0) return leg;
    let next = leg.status;
    if (snaps.every(isTerminal)) {
      next = summarizeEvidence(snaps).deliverable ? LEG_STATUS.COMPLETED : LEG_STATUS.IN_REVIEW;
    } else {
      // 有在途即 active——含 completed/in_review 回退（#115：派生物化/人工补单会让
      // 已完结腿出现在途 WU，腿状态随真实工作量回摆；delivered 终态已在上面提前 return）
      next = LEG_STATUS.ACTIVE;
    }
    return next === leg.status ? leg : { ...leg, status: next };
  });
  if (newLegs.some((l, i) => l !== legs[i])) {
    await projectService.update(projectId, { deliveries: newLegs });
    logger.info('[PMO] Delivery legs updated', {
      projectId,
      legs: newLegs.map(l => ({ branch: l.branch, status: l.status })),
    });
  }

  if (done === snapshots.length) {
    const allLegsDone = newLegs.every((leg, i) =>
      leg.status === LEG_STATUS.COMPLETED || leg.status === LEG_STATUS.DELIVERED || legSnapsList[i].length === 0);
    if (allLegsDone) {
      // 全腿完结 → completed（skipValidation 系统汇总直写，自动带 completedAt 与 progress=100）
      await projectService.updateStatus(projectId, PROJECT_STATUS.COMPLETED, true);
      logger.info('[PMO] Project completed (all delivery legs done)', {
        projectId,
        workUnitCount: snapshots.length,
        legCount: legs.length,
      });
    } else if (project.status === PROJECT_STATUS.ACTIVE || project.status === PROJECT_STATUS.PENDING) {
      // 全腿活干完但有腿证据缺口 → in_review（等证据验收），不冒充 completed；
      // 纠偏路径同单腿（幂等补证据 → 读取时重算翻 completed）。
      if (progress !== project.progress) await projectService.update(projectId, { progress });
      await projectService.updateStatus(projectId, PROJECT_STATUS.IN_REVIEW, true);
      logger.info('[PMO] Project in_review (all legs finished, evidence gaps)', {
        projectId,
        workUnitCount: snapshots.length,
        legs: newLegs.map(l => ({ branch: l.branch, status: l.status })),
      });
    }
  } else if (progress !== project.progress) {
    await projectService.update(projectId, { progress });
    logger.info('[PMO] Project progress updated', { projectId, progress, done, total: snapshots.length });
  }
}
