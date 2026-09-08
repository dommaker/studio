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
 * 完结口径与 REQ 状态汇总一致（TERMINAL_WORKUNIT_STATUSES：in_review 视同工作完成）——
 * 仅用于状态翻转判定；progress 分子与 WU 完成管道同源（#282：
 * deriveDisplayState.workFinished = 存储态 done/closed，in_review/failed 不计进度），
 * 消除「管道 0/1 WU 完成却 progress=100」的口径矛盾。
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
 *
 * #410（#323 残余收口）：消费侧改 per-project 聚合 memo + 去抖合并，消除每事件
 * 全量存储读（reqService.list() + getIndex() 全量克隆）。事件负载（snapshotToData
 * 全量数据）直接喂 memo，稳态零存储读：
 *   - memo 按 projectId 维护项目兄弟 WU 的归约输入最小字段集（EvidenceWuInput：
 *     id/status/type/metadata——progress 分子、完结判定、证据汇总、分腿的输入，
 *     口径仍由 evidence-summary / deriveDisplayState 解释，memo 不重新解释）；
 *   - 归属复用 resolveWuProjectId 口径（reqId 绑定优先 → pmoId 戳兜底）；REQ 归属
 *     缓存只记正向绑定，未命中走 scoped reqService.get(reqId) 单条查（现状本来就
 *     每事件 get 一次），回源时整体重建自愈 rebind 漂移；
 *   - 触发口径不变：reqId 路径仅 REQ 已绑定项目才触发归约；无 reqId 路径戳命中即
 *     触发；REQ 未绑定但有戳 → 只记账不触发（同现状）。workunit.created 只记账不
 *     触发（现状 created 本就不回写），感知「created 直落非终态、无 status_changed」
 *     的新增 WU；
 *   - 冷启动（memo 缺失/未回源）首个归约回源一次，之后纯增量；
 *   - 同项目 50ms 窗口去抖：连续事件合并为一次归约回写，串行化仍由 syncChains 承载；
 *   - 哨兵漂移兜底：派生哨兵（analysisTasksSpawnedAt/specTasksSpawnedAt）经
 *     updateMetadata 落档不发事件，memo 可能滞后为「未落定」。哨兵只增不减——memo
 *     判「已落定」必为真；判「未落定」时回源复核一次再判定，语义与现状（永远读
 *     新鲜存储）逐点一致；
 *   - 直调路径（syncProjectProgress 导出：routes 读取纠偏 / 测试）恒回源，语义 =
 *     现状全量读。已知接受项：WU delete 无事件，memo 靠冷启动/复核/直调回源自愈。
 */
import { eventBus, FileStore, logger, createSettledTracker, deriveDisplayState } from '@dommaker/studio-shared';
import { RequirementService, TERMINAL_WORKUNIT_STATUSES } from '../requirements/requirement.service.js';
import { projectService, resolveDeliveries, LEG_STATUS, PROJECT_STATUS, type DeliveryLeg, type ProjectData } from './project.service.js';
import {
  parseWuMetaPmoId,
  selectProjectSnapshots,
  summarizeEvidence,
  partitionSnapshotsByLeg,
  buildReqProjectMap,
  type EvidenceWuInput,
} from './evidence-summary.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';

// 兼容现有引用方（原定义已移至 evidence-summary.ts 共享口径）
export { parseWuMetaPmoId };

/** status_changed / created 事件负载中 rollup 消费的最小字段集（snapshotToData 全量数据的子集） */
interface WuRollupEventData {
  id: string;
  status: string;
  type: string;
  reqId?: string | null;
  metadata?: string | null;
}

/**
 * 挂载进度回写订阅，返回解绑函数（测试用）。
 * 生产环境在 API 启动时调用一次（见 apps/api/src/index.ts）。
 */
export function initPmoProgressRollup(fileStore?: FileStore): () => void {
  const statusHandler = (payload: { workunit?: WuRollupEventData }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    rollupTracker.track(handleWuStatusChanged(wu, fileStore).catch(err =>
      logger.warn('[PMO] Progress rollup failed (non-blocking)', { workUnitId: wu.id, error: String(err) })
    ));
  };
  // #410：created 只记账不触发归约（与现状一致——created 本就不回写），
  // 让 memo 感知「created 直落非终态、无 status_changed」的新增 WU
  const createdHandler = (payload: { workunit?: WuRollupEventData }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    rollupTracker.track(attachEventWu(wu, fileStore).then(() => undefined).catch(err =>
      logger.warn('[PMO] Progress memo attach failed (non-blocking)', { workUnitId: wu.id, error: String(err) })
    ));
  };
  eventBus.subscribe('workunit.status_changed', statusHandler);
  eventBus.subscribe('workunit.created', createdHandler);
  return () => {
    eventBus.unsubscribe('workunit.status_changed', statusHandler);
    eventBus.unsubscribe('workunit.created', createdHandler);
  };
}

/**
 * #158 测试可观测性（纯增量，不改变发布/消费行为）：登记在途回写 promise。
 * 事件订阅是 fire-and-forget，publish 同步触发 handler 后回写链路仍在异步推进，
 * 测试侧原本只能盲等（waitFor 轮询）——全量负载下事件循环饥饿会吃满超时预算（偶发红）。
 * #228：实现归并到 studio-shared 的 createSettledTracker（原三处复制之一）。
 * #410：track 的 promise 贯穿去抖窗口——handler 在 publish 同步链内登记，
 * await transitionStatus 返回时在途回写（含挂起的去抖归约）必已登记。
 */
const rollupTracker = createSettledTracker();

/**
 * 等待当前已触发的全部进度回写落定（测试用确定性信号，替代 waitFor 盲等）。
 * publish 在 transitionStatus await 链内同步发射（workunit.service.ts），故
 * await transitionStatus 返回时在途回写必已登记，await 本函数即等到回写真正完成。
 * #410 去抖引入延迟后语义不变：返回时挂起的去抖归约同样已落定。
 */
export async function waitForPmoProgressRollupSettled(): Promise<void> {
  await rollupTracker.waitForSettled();
}

// ============================================
// #410 per-project 聚合 memo + 去抖合并（详见文件头）
// ============================================

/** 项目兄弟 WU 的归约输入聚合（稳态不再回读存储） */
interface ProjectRollupMemo {
  wus: Map<string, EvidenceWuInput>;
  /** true = 只有事件记账、尚未回源构建（首个归约时回源一次补齐兄弟 WU） */
  cold: boolean;
}
const memos = new Map<string, ProjectRollupMemo>();
/** wuId → 当前归属项目（归属迁移时从旧项目 memo 移除，单 WU 不双计） */
const wuProject = new Map<string, string>();
/**
 * REQ 归属缓存，按 FileStore 分桶（REQ 序号按存储分配，多存储同号会互撞——
 * 生产单存储，测试每用例一个临时存储）。只记正向绑定——负缓存会被 REQ 后绑定
 * stale；回源时重建对应桶。
 */
const reqProjectByStore = new Map<FileStore | null, Map<string, string>>();
const storeKey = (fs?: FileStore): FileStore | null => fs ?? null;

/** REQ 归属解析：缓存命中零读；未命中 scoped 单条查（现状每事件本来就 get 一次） */
async function resolveReqProjectCached(reqId: string, fileStore?: FileStore): Promise<string | null> {
  const key = storeKey(fileStore);
  const cached = reqProjectByStore.get(key)?.get(reqId);
  if (cached) return cached;
  const requirement = await new RequirementService(fileStore).get(reqId);
  const projectId = requirement?.projectId ?? null;
  if (projectId) {
    let bucket = reqProjectByStore.get(key);
    if (!bucket) {
      bucket = new Map<string, string>();
      reqProjectByStore.set(key, bucket);
    }
    bucket.set(reqId, projectId);
  }
  return projectId;
}

/**
 * 事件负载喂 memo（status_changed 与 created 共用）。返回归属项目与是否允许触发归约：
 * 归属口径 = resolveWuProjectId（reqId 绑定优先 → pmoId 戳兜底）；触发口径保持现状——
 * reqId 路径仅 REQ 已绑定项目才触发（REQ 未绑定但有戳只记账，由兄弟事件/读取纠偏带动），
 * 无 reqId 路径戳命中即触发。
 */
async function attachEventWu(
  wu: WuRollupEventData,
  fileStore?: FileStore,
): Promise<{ projectId: string | null; trigger: boolean }> {
  let projectId: string | null;
  let trigger: boolean;
  if (wu.reqId) {
    const bound = await resolveReqProjectCached(wu.reqId, fileStore);
    projectId = bound ?? parseWuMetaPmoId(wu.metadata);
    trigger = bound !== null;
  } else {
    projectId = parseWuMetaPmoId(wu.metadata);
    trigger = projectId !== null;
  }
  const prev = wuProject.get(wu.id);
  if (prev && prev !== projectId) {
    memos.get(prev)?.wus.delete(wu.id);
    wuProject.delete(wu.id);
  }
  if (!projectId) return { projectId: null, trigger: false };
  let memo = memos.get(projectId);
  if (!memo) {
    memo = { wus: new Map<string, EvidenceWuInput>(), cold: true };
    memos.set(projectId, memo);
  }
  memo.wus.set(wu.id, { id: wu.id, status: wu.status, type: wu.type, metadata: wu.metadata ?? null });
  wuProject.set(wu.id, projectId);
  return { projectId, trigger };
}

async function handleWuStatusChanged(wu: WuRollupEventData, fileStore?: FileStore): Promise<void> {
  const { projectId, trigger } = await attachEventWu(wu, fileStore);
  if (trigger && projectId) await scheduleEventRollup(projectId, fileStore);
}

/** 回源重建 memo（冷启动 / 哨兵复核 / 直调纠偏共用）：全量读一次，顺带重建本存储的 REQ 归属缓存。
 *  不做负载覆盖——真实事件的存储持久化先于 publish，回源读到的恒 ≥ payload（哨兵等后发
 *  metadata 也在内），直接以存储为准最新最准。 */
async function resourceMemo(projectId: string, fileStore?: FileStore): Promise<ProjectRollupMemo> {
  const fs = fileStore ?? new FileStore();
  const reqService = new RequirementService(fs);
  const requirements = await reqService.list();
  reqProjectByStore.set(storeKey(fs), buildReqProjectMap(requirements));
  const index = await fs.getIndex();
  const wus = new Map<string, EvidenceWuInput>();
  for (const s of selectProjectSnapshots(projectId, requirements, index)) {
    wus.set(s.id, { id: s.id, status: s.status, type: s.type, metadata: s.metadata });
    wuProject.set(s.id, projectId);
  }
  const memo: ProjectRollupMemo = { wus, cold: false };
  memos.set(projectId, memo);
  return memo;
}

/** #410 去抖窗口：同项目窗口内连续事件合并为一次归约回写（测试可调整以锁定合并行为，生产恒用默认 50ms） */
export const rollupTiming = { debounceMs: 50 };
const scheduledRollups = new Map<string, Promise<void>>();

/**
 * 去抖调度：窗口内已有挂起归约则复用（挂起的归约会吃到 memo 最新态，后到事件只需喂 memo）；
 * 否则挂起一个 debounceMs 后的归约（仍走 syncChains 串行化）。返回的 promise 在归约真正落定后
 * 才 resolve——handler await 它并经 rollupTracker 登记，waitForPmoProgressRollupSettled 语义不变。
 */
function scheduleEventRollup(projectId: string, fileStore?: FileStore): Promise<void> {
  const pending = scheduledRollups.get(projectId);
  if (pending) return pending;
  const p = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      scheduledRollups.delete(projectId);
      enqueueProjectSync(projectId, () => doSyncProjectProgress(projectId, fileStore, false)).then(resolve, reject);
    }, rollupTiming.debounceMs);
    timer.unref?.(); // best-effort 回写不吊住进程退出
  });
  scheduledRollups.set(projectId, p);
  return p;
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

function enqueueProjectSync(projectId: string, task: () => Promise<void>): Promise<void> {
  const run = (syncChains.get(projectId) ?? Promise.resolve())
    .catch(() => { /* 前序失败不阻断后续 */ })
    .then(task);
  syncChains.set(projectId, run);
  // 链尾回收，避免 Map 随项目数无限增长
  const cleanup = () => { if (syncChains.get(projectId) === run) syncChains.delete(projectId); };
  run.then(cleanup, cleanup);
  return run;
}

/** #282：progress 分子唯一口径 = WU 完成管道的 workFinished（存储态 done/closed），两处 progress 计算共用 */
function isWorkFinished(s: EvidenceWuInput): boolean {
  return deriveDisplayState({ status: s.status, metadata: s.metadata }).workFinished;
}

const isTerminalWu = (s: EvidenceWuInput): boolean => TERMINAL_WORKUNIT_STATUSES.includes(s.status);

/**
 * 重算单个 PMO 项目进度：该项目下全部 Requirement 关联 WU 的完结比例。
 * Requirement 链路拿不到关联 WU 时回退按 metadata.pmoId 归属统计（analysis 派生链），口径不变。
 * completed/cancelled 项目不再回写（不回退）；无关联 WU 时不动作。
 * 全部完结时按证据翻转：deliverable → completed；否则 active/pending → in_review（等证据验收）。
 * #410：直调路径（routes 读取纠偏 / 测试）——恒回源，语义 = 现状全量读；
 * 事件路径走 scheduleEventRollup 去抖后进同一串行链（memo 增量，稳态零存储读）。
 */
export function syncProjectProgress(projectId: string, fileStore?: FileStore): Promise<void> {
  return enqueueProjectSync(projectId, () => doSyncProjectProgress(projectId, fileStore, true));
}

/**
 * #115 T9：派生链未落定判定（见文件头）。命中 → 本次不得翻 completed/in_review
 * （「全部完结」是派生前的假相），progress 照写。
 */
export function derivationPending(project: ProjectData, snapshots: EvidenceWuInput[]): boolean {
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

/**
 * @param resourced true = 直调路径，恒回源重建 memo（现状全量读语义）；
 *                  false = 事件路径，memo 增量（冷启动首个归约回源一次，稳态零存储读）
 */
async function doSyncProjectProgress(projectId: string, fileStore: FileStore | undefined, resourced: boolean): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) return;
  if (project.status === PROJECT_STATUS.COMPLETED || project.status === PROJECT_STATUS.CANCELLED) return;

  let memo = memos.get(projectId);
  let fresh = resourced;
  if (resourced || !memo || memo.cold) {
    memo = await resourceMemo(projectId, fileStore);
    fresh = true;
  }
  const snapshots = [...memo.wus.values()];
  if (snapshots.length === 0) return;

  // #410 哨兵漂移兜底：派生哨兵落档不发事件，memo 可能滞后为「未落定」；哨兵只增不减，
  // memo 判「已落定」必为真——只有 memo 判「未落定」才回源复核一次，按新鲜存储走完整判定
  // （本次调用刚回源过的数据即新鲜存储，不再重复复核）
  if (!fresh && snapshots.every(isTerminalWu) && derivationPending(project, snapshots)) {
    return doSyncProjectProgress(projectId, fileStore, true);
  }

  // #113 T7：显式多腿项目走逐腿状态机（腿状态独立演进 + 全腿完结才翻整体）；
  // 单腿（无 deliveries / 合成单腿）保持下方现状路径逐字节一致。
  const legs = resolveDeliveries(project);
  if (legs.length > 1) {
    await doSyncMultiLegProgress(project, legs, snapshots);
    return;
  }

  const done = snapshots.filter(isTerminalWu).length;
  const finished = snapshots.filter(isWorkFinished).length;
  const progress = Math.round((finished / snapshots.length) * 100);

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
 *   - 项目整体：progress 口径同单腿（#282 起分子 = workFinished，与 WU 完成管道同源）；
 *     翻转条件 = 全部腿 completed/delivered（零 WU 腿视为满足）→ completed，
 *     否则同单腿语义置 in_review。
 */
async function doSyncMultiLegProgress(
  project: ProjectData,
  legs: DeliveryLeg[],
  snapshots: EvidenceWuInput[],
): Promise<void> {
  const projectId = project.id;
  const done = snapshots.filter(isTerminalWu).length;
  const finished = snapshots.filter(isWorkFinished).length;
  const progress = Math.round((finished / snapshots.length) * 100);

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
    if (snaps.every(isTerminalWu)) {
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
