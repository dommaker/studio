/**
 * PMO-b（2026-07-28 分析文档 §4.5，决策 1）：交付守卫与台账。
 *
 * 交付动作 = 把产物从可逆变为共享/不可逆的那个动作，因工程而异：
 *   - auto-merge：studio 执行 PMO 分支 → 默认分支的本地合并（缺证据硬性拒绝，不 push）；
 *   - branch-only（默认）：studio 不碰合并/发布链路，只回答「这个分支谁敢说它好了」——
 *     台账标记可交付/缺什么，分支与证据交下游（发布系统各有链路）。
 *
 * 台账口径：WU 证据（l1 自动验证 / l2 agent 评审 / l3 人工确认）一律过
 * evidence-summary 共享口径（底层仍走 deriveDisplayState 派生，铁律：禁止各自解释 attestations）。
 * l1 只对代码类 WU（task/bug/feature/refactor）要求；l2 豁免 review/analysis/decision/spec
 * （dispatcher 不派评审，验收闸是人工 L3）；l3 对所有已完成 WU 要求；代码类 finished WU
 * 另需 merge receipt 与目标验证可接受（unavailable 仅 L3 approved 可交付）。
 *
 * #113 T7（#106 子票）：显式多腿项目（resolveDeliveries > 1）按腿循环——台账/证据齐缺/
 * deliverable 判定/auto-merge 逐腿独立；WU→腿归属走 evidence-summary 的 matchWuToLeg
 * （workspaceRoot/worktreeBaseRepo 命中腿 gitRepo，或 pmoBranch 命中腿 branch），
 * 未分腿公共 WU 保守计入每条腿。整体 deliverable = 全部腿 deliverable（零 WU 腿不阻断，
 * 全项目无 WU 仍不可交付）；auto-merge 全腿交付才写项目级 deliveredAt。
 * 单腿（无 deliveries / 合成单腿）：不输出 legs 字段，行为与现状逐字节一致。
 */
import { FileStore, LockTimeoutError, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { isValidGitBranch } from '@dommaker/studio-contract';
import { execFileAsync } from '../../core/exec-async.js';
import { withDeliveryLegLock } from '../../core/delivery-leg-lock.js';
import { projectService, resolveDeliveries, resolveDeliveryPolicy, LEG_STATUS, PROJECT_STATUS, type DeliveryLeg, type DeliveryLegStatus, type DeliveryPolicy, type ProjectData } from './project.service.js';
import { RequirementService } from '../requirements/index.js';
import { selectProjectSnapshots, summarizeEvidence, partitionSnapshotsByLeg, CODE_TYPES, type EvidenceSummary } from './evidence-summary.js';
import { postProjectMilestone } from './delivery-notify.js';
// P2-c 拆环：sumTokensForWorkUnits 转调用点动态 import（pmo→agents 静态边清零）
import { assertMandateAllows, hasUnsettledMergeEffect, parseWuMetadata } from '../workunit/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getStore } from '../../core/store.js';
import { withExecutionRepo } from '../../utils/execution-repo-policy.js';


const GIT_OP_TIMEOUT_MS = 15_000;
const MERGE_TIMEOUT_MS = 60_000;

export interface DeliveryStatus {
  projectId: string;
  pmoNumber: string;
  branch: string | null;
  policy: DeliveryPolicy;
  gitRepo: string | null;
  wu: {
    total: number;
    finished: number;
    inFlight: number;
    /** 在途 WU 的状态分布（done/closed 只计入 finished；供前端进展卡按 WU 口径渲染） */
    byStatus: { unassigned: number; active: number; inReview: number; blocked: number };
  };
  evidence: {
    /** 缺各层证据的 WU id（已完成但证据不齐） */
    l1Missing: string[];
    l2Missing: string[];
    l3Missing: string[];
    /** 代码 WU 缺可接受的 merge receipt（合并事实完整且目标验证通过） */
    mergeMissing: string[];
    /** 代码 WU 无目标验证命令且缺 L3 人工确认 */
    verificationUnavailable: string[];
    /** l2 中自评数（决策 5：评审独立性参考，不阻断交付） */
    selfReviewCount: number;
  };
  /** 可交付 = 有 WU 且全部完成且证据齐（l1 限代码类，l2 豁免 review/analysis/decision/spec）；多腿 = 全部腿 deliverable */
  deliverable: boolean;
  /** 人话缺口清单（branch-only 标记 / auto-merge 拒绝原因共用；多腿逐腿带 [分支] 前缀） */
  missing: string[];
  /** 项目 WU 链路 token 总消耗（studio-events.jsonl 的 workunit:tokens 事件求和，best-effort） */
  tokens: number;
  /**
   * #376 归档口径：completed 项目实时重算零 WU = true。
   * progress 是 rollup 写入后不回看的历史快照，WU 存储清理/重建后快照为空集，
   * 「100% + 六卡全 0」是归档分叉而非在途真相——前端据此显示归档提示而非全 0。
   * 谓词只看 COMPLETED（deliveredAt 不翻 status，不作终态代理，见实现处注释）。
   */
  archived: boolean;
  /** 已完成但证据有缺口的 WU 明细（供前端渲染行动清单；missing 顺序固定 l1→l2→l3→merge） */
  gaps: Array<{ id: string; title: string; type: string; missing: Array<'l1' | 'l2' | 'l3' | 'merge'> }>;
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliverCommit: string | null;
  /** #469：项目绑定频道（交付播报发帖用；未 publish 为 null → 只落持久通知） */
  channelId: string | null;
  /** #113 T7：逐腿台账（仅显式多腿项目输出；单腿为 undefined，回归硬要求） */
  legs?: LegDeliveryStatus[];
}

/** #113 T7：单腿台账（口径与项目级相同，按腿 WU 集独立汇总） */
export interface LegDeliveryStatus {
  gitRepo: string | null;
  branch: string | null;
  /** 腿状态（LEG_STATUS 词表；progress-rollup 逐腿回写、deliverProject 逐腿落档） */
  status: DeliveryLegStatus;
  /** 腿级交付落档（auto-merge 逐腿写入；branch-only 永为 null） */
  deliveredAt: string | null;
  deliverCommit: string | null;
  wu: DeliveryStatus['wu'];
  evidence: DeliveryStatus['evidence'];
  deliverable: boolean;
  missing: string[];
  gaps: DeliveryStatus['gaps'];
  tokens: number;
}

export interface DeliveryDeps {
  getProject?: (id: string) => Promise<ProjectData | null>;
  getProjectFresh?: (id: string) => Promise<ProjectData | null>;
  listRequirements?: () => Promise<Array<{ id: string; projectId?: string | null }>>;
  getIndex?: () => Promise<WorkUnitSnapshot[]>;
  updateProject?: (id: string, input: Record<string, unknown>) => Promise<ProjectData>;
  /** token 聚合注入点（测试用；缺省走 token-usage.service 的 sumTokensForWorkUnits） */
  sumTokens?: (workUnitIds: Set<string>) => Promise<number>;
  /** 执行根 capability 注入点；生产缺省统一 execution-repo-policy，测试可传原路径 passthrough。 */
  withRepo?: <T>(repo: string, callback: (capabilityPath: string) => Promise<T>) => Promise<T>;
  /** 同腿 Git 临界区注入点；生产使用 common-dir + branch 跨进程锁。 */
  withLegLock?: <T>(repo: string, branch: string, callback: () => Promise<T>) => Promise<T>;
}

function mergePendingIds(snapshots: WorkUnitSnapshot[]): string[] {
  return snapshots.filter(snapshot => snapshot.status === 'in_review'
    && hasUnsettledMergeEffect(snapshot.metadata)).map(snapshot => snapshot.id);
}

function legSnapshots(project: ProjectData, snapshots: WorkUnitSnapshot[], leg: Pick<DeliveryLeg, 'gitRepo' | 'branch'>): WorkUnitSnapshot[] {
  const legs = resolveDeliveries(project);
  if (legs.length <= 1) return snapshots;
  const index = legs.findIndex(candidate => candidate.gitRepo === leg.gitRepo && candidate.branch === leg.branch);
  const { perLeg, shared } = partitionSnapshotsByLeg(legs, snapshots);
  return index >= 0 ? [...perLeg[index], ...shared] : [];
}

function resolveLegLocker(fileStore: FileStore | undefined, deps?: DeliveryDeps): NonNullable<DeliveryDeps['withLegLock']> {
  if (deps?.withLegLock) return deps.withLegLock;
  const fs = fileStore ?? getStore();
  return (repo, branch, callback) => withDeliveryLegLock({ fileStore: fs, repo, branch, timeoutMs: 50 }, callback);
}

/** WU 展示名：metadata.title 优先（metadata 是 JSON 字符串，解析失败/缺失回退 scope） */
function wuTitle(s: WorkUnitSnapshot): string {
  const title = parseWuMetadata(s.metadata).title;
  return typeof title === 'string' && title.length > 0 ? title : s.scope;
}

interface EvidenceLedger {
  summary: EvidenceSummary;
  missing: string[];
  gaps: DeliveryStatus['gaps'];
  tokens: number;
}

/** 一组 WU 快照的证据台账：齐缺汇总 + 人话缺口清单 + gaps 明细 + token 求和（项目级与逐腿共用） */
async function buildLedger(
  snapshots: WorkUnitSnapshot[],
  sumTokens: (workUnitIds: Set<string>) => Promise<number>,
): Promise<EvidenceLedger> {
  const summary = summarizeEvidence(snapshots);
  const { l1Missing, l2Missing, l3Missing, mergeMissing, verificationUnavailable } = summary;
  const inFlight = summary.inFlight;

  // gaps：已完成但有证据缺口的 WU 明细（missing 顺序固定 l1→l2→l3→merge，供前端渲染行动清单）
  const missingByWu = new Map<string, Array<'l1' | 'l2' | 'l3' | 'merge'>>();
  const pushGap = (id: string, level: 'l1' | 'l2' | 'l3' | 'merge') => {
    const arr = missingByWu.get(id) ?? [];
    arr.push(level);
    missingByWu.set(id, arr);
  };
  for (const id of l1Missing) pushGap(id, 'l1');
  for (const id of l2Missing) pushGap(id, 'l2');
  for (const id of l3Missing) pushGap(id, 'l3');
  for (const id of mergeMissing) pushGap(id, 'merge');
  for (const id of verificationUnavailable) pushGap(id, 'merge');
  const gaps = snapshots
    .filter(s => missingByWu.has(s.id))
    .map(s => ({ id: s.id, title: wuTitle(s), type: s.type, missing: missingByWu.get(s.id)! }));

  // token 聚合 best-effort：事件文件缺失/聚合失败按 0，不拖垮台账主流程
  const tokens = await sumTokens(new Set(snapshots.map(s => s.id))).catch(() => 0);

  const missing: string[] = [];
  // 界面文案对齐 #385 词表：WU→任务、L1/L2/L3 编号转白话（自动验证/Agent 评审/人工确认）；插值为 WU 编号本身除外
  if (snapshots.length === 0) missing.push('无关联任务');
  if (inFlight > 0) missing.push(`${inFlight} 个任务未完成`);
  if (l1Missing.length > 0) missing.push(`${l1Missing.length} 个代码类任务缺自动验证（${l1Missing.slice(0, 3).join(', ')}${l1Missing.length > 3 ? '…' : ''}）`);
  if (l2Missing.length > 0) missing.push(`${l2Missing.length} 个任务缺 Agent 评审（${l2Missing.slice(0, 3).join(', ')}${l2Missing.length > 3 ? '…' : ''}）`);
  if (l3Missing.length > 0) missing.push(`${l3Missing.length} 个任务缺人工确认（${l3Missing.slice(0, 3).join(', ')}${l3Missing.length > 3 ? '…' : ''}）`);
  if (mergeMissing.length > 0) missing.push(`${mergeMissing.length} 个代码类任务缺有效合并回执或目标验证未通过（${mergeMissing.slice(0, 3).join(', ')}${mergeMissing.length > 3 ? '…' : ''}）`);
  if (verificationUnavailable.length > 0) missing.push(`${verificationUnavailable.length} 个代码类任务无目标验证命令，需人工确认（${verificationUnavailable.slice(0, 3).join(', ')}${verificationUnavailable.length > 3 ? '…' : ''}）`);

  return { summary, missing, gaps, tokens };
}

interface DeliveryLedgerSnapshot {
  status: DeliveryStatus;
  project: ProjectData;
  snapshots: WorkUnitSnapshot[];
}

/** PMO 台账：WU 汇总 + 证据齐缺（只读，无任何副作用）；多腿项目附逐腿台账 */
async function loadDeliveryStatus(
  projectId: string,
  fileStore?: FileStore,
  deps?: DeliveryDeps,
  fresh = false,
): Promise<DeliveryLedgerSnapshot | null> {
  const getProject = fresh
    ? deps?.getProjectFresh ?? deps?.getProject ?? (async (id: string) => projectService.getFresh(id))
    : deps?.getProject ?? (async (id: string) => projectService.get(id));
  const project = await getProject(projectId);
  if (!project) return null;

  const fs = fileStore ?? getStore();
  const listRequirements = deps?.listRequirements
    ?? (async () => new RequirementService(fs).list());
  const getIndex = deps?.getIndex ?? (async () => fs.getIndex());

  const snapshots = selectProjectSnapshots(projectId, await listRequirements(), await getIndex());
  // P2-c 拆环：pmo→agents 静态边转动态 import（包装保持 sumTokens 注入签名不变）
  const sumTokens = deps?.sumTokens
    ?? (async (workUnitIds: Set<string>) => (await import('../agents/index.js')).sumTokensForWorkUnits(workUnitIds));
  const ledger = await buildLedger(snapshots, sumTokens);
  const { summary } = ledger;

  // #113 T7：显式多腿 → 逐腿台账（腿 WU 集 = 本腿命中 + 未分腿公共 WU，保守口径）
  const legs = resolveDeliveries(project);
  let legStatuses: LegDeliveryStatus[] | undefined;
  let deliverable = summary.deliverable;
  let missing = ledger.missing;
  if (legs.length > 1) {
    const { perLeg, shared } = partitionSnapshotsByLeg(legs, snapshots);
    legStatuses = [];
    for (let i = 0; i < legs.length; i++) {
      const legSnaps = [...perLeg[i], ...shared];
      const legLedger = await buildLedger(legSnaps, sumTokens);
      legStatuses.push({
        gitRepo: legs[i].gitRepo,
        branch: legs[i].branch,
        status: legs[i].status,
        deliveredAt: legs[i].deliveredAt ?? null,
        deliverCommit: legs[i].deliverCommit ?? null,
        wu: {
          total: legLedger.summary.total,
          finished: legLedger.summary.finished,
          inFlight: legLedger.summary.inFlight,
          byStatus: legLedger.summary.byStatus,
        },
        evidence: {
          l1Missing: legLedger.summary.l1Missing,
          l2Missing: legLedger.summary.l2Missing,
          l3Missing: legLedger.summary.l3Missing,
          mergeMissing: legLedger.summary.mergeMissing,
          verificationUnavailable: legLedger.summary.verificationUnavailable,
          selfReviewCount: legLedger.summary.selfReviewCount,
        },
        deliverable: legLedger.summary.deliverable,
        missing: legLedger.missing,
        gaps: legLedger.gaps,
        tokens: legLedger.tokens,
      });
    }
    // 整体 = 全部腿 deliverable（已 delivered 腿已满足豁免、零 WU 腿不阻断）；全项目无 WU 仍不可交付
    deliverable = snapshots.length > 0
      && legStatuses.every(l => l.status === LEG_STATUS.DELIVERED || l.wu.total === 0 || l.deliverable);
    // 整体缺口清单逐腿带 [分支] 前缀（已 delivered/零 WU 腿不出清单）；全项目无 WU 保持单条「无关联 WorkUnit」
    if (snapshots.length > 0) {
      missing = legStatuses.flatMap(l =>
        (l.status === LEG_STATUS.DELIVERED || l.wu.total === 0) ? [] : l.missing.map(m => `[${l.branch ?? l.gitRepo ?? '未命名腿'}] ${m}`));
    }
  }

  return {
    status: {
      projectId: project.id,
      pmoNumber: project.pmoNumber,
      branch: project.gitBranch || project.pmoNumber || null,
      policy: resolveDeliveryPolicy(project),
      gitRepo: project.gitRepo ?? null,
      wu: { total: summary.total, finished: summary.finished, inFlight: summary.inFlight, byStatus: summary.byStatus },
      evidence: {
        l1Missing: summary.l1Missing,
        l2Missing: summary.l2Missing,
        l3Missing: summary.l3Missing,
        mergeMissing: summary.mergeMissing,
        verificationUnavailable: summary.verificationUnavailable,
        selfReviewCount: summary.selfReviewCount,
      },
      deliverable,
      missing,
      tokens: ledger.tokens,
      // #376：completed + 实时重算零 WU = 归档分叉（progress 历史快照 vs 存储已清理）。
      // 谓词只看 COMPLETED（状态机唯一终点）：deliveredAt 不是终态代理——deliverProject
      // 只落档不翻 status，且 in_review → cancelled 合法，带上它会误标 cancelled/在途项目。
      // 已知边界：零任务直接 completed 的项目同样命中（无从分辨「从未有过 WU」与
      // 「WU 已清理」），属保守误报——归档提示文案两种情形都成立。
      archived: snapshots.length === 0 && project.status === PROJECT_STATUS.COMPLETED,
      gaps: ledger.gaps,
      deliveredAt: project.deliveredAt ?? null,
      deliveredBy: project.deliveredBy ?? null,
      deliverCommit: project.deliverCommit ?? null,
      channelId: project.channelId ?? null,
      ...(legStatuses ? { legs: legStatuses } : {}),
    },
    project,
    snapshots,
  };
}

export async function getDeliveryStatus(
  projectId: string,
  fileStore?: FileStore,
  deps?: DeliveryDeps,
): Promise<DeliveryStatus | null> {
  return (await loadDeliveryStatus(projectId, fileStore, deps))?.status ?? null;
}

/** 最终交付只重验代码 WU；plan/review 等非代码工作不承担腿交付权限。 */
function findMandateRejection(
  snapshots: WorkUnitSnapshot[],
  action: 'deliver' | 'mark-delivered',
  scope: { repo: string; leg: string | null },
): string | null {
  for (const snapshot of snapshots) {
    if (!CODE_TYPES.has(snapshot.type)) continue;
    try {
      assertMandateAllows(snapshot, action, scope);
    } catch (error) {
      return `${snapshot.id}: ${getErrorMessage(error)}`;
    }
  }
  return null;
}

function findProjectMandateRejection(
  project: ProjectData,
  snapshots: WorkUnitSnapshot[],
  action: 'deliver' | 'mark-delivered',
): string | null {
  for (const leg of resolveDeliveries(project)) {
    if (!leg.gitRepo || !leg.branch) continue;
    const rejection = findMandateRejection(legSnapshots(project, snapshots, leg), action, {
      repo: leg.gitRepo, leg: leg.branch,
    });
    if (rejection) return rejection;
  }
  return null;
}

/** #113 T7：单腿交付结果（多腿 deliverProject 逐腿产出） */
export interface LegDeliverResult {
  gitRepo: string | null;
  branch: string | null;
  delivered: boolean;
  reason?: 'already-delivered' | 'skipped-no-wu' | 'no-repo' | 'checkout-mismatch' | 'conflict' | 'not-ready' | 'merge-pending' | 'mandate-rejected';
  deliverCommit?: string;
  conflictFiles?: string[];
  detail?: string;
}

export type DeliverOutcome =
  | { delivered: true; deliverCommit: string; legs?: LegDeliverResult[] }
  | { delivered: false; reason: 'branch-only' | 'not-ready' | 'merge-pending' | 'mandate-rejected' | 'no-repo' | 'checkout-mismatch' | 'conflict' | 'not-found'; missing?: string[]; conflictFiles?: string[]; detail?: string; legs?: LegDeliverResult[] };

type MergeResult =
  | { ok: true; deliverCommit: string }
  | { ok: false; reason: 'no-repo' | 'checkout-mismatch' | 'conflict'; conflictFiles?: string[]; detail?: string };

/**
 * 单仓库合并：当前 checkout 必须是默认分支（防打扰闸，人不欠 studio 一个干净主仓），
 * 然后 branch → 默认分支本地合并（--no-ff，不 push）；冲突不自动 rebase，转人工。
 */
async function mergeBranchIntoDefault(
  repo: string,
  branch: string,
  message: string,
  withRepo: NonNullable<DeliveryDeps['withRepo']> = withExecutionRepo,
): Promise<MergeResult> {
  return withRepo(repo, capabilityRepo => mergeBranchIntoDefaultCapability(capabilityRepo, branch, message));
}

async function mergeBranchIntoDefaultCapability(repo: string, branch: string, message: string): Promise<MergeResult> {
  // 存量数据纵深防线：必须在首个 rev-parse/diff 之前失败，危险分支零子进程。
  if (!isValidGitBranch(branch)) {
    return { ok: false, reason: 'conflict', detail: `非法 PMO 分支名，拒绝交付: ${branch}` };
  }
  let currentBranch = '';
  try {
    const stdout = await execFileAsync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, timeout: GIT_OP_TIMEOUT_MS });
    currentBranch = stdout.trim();
  } catch (err) {
    return { ok: false, reason: 'no-repo', detail: `git 仓库不可用: ${getErrorMessage(err)}` };
  }
  // 交付目标 = 默认分支探测（origin/HEAD → main → master），与 worktree 机器同口径
  const { getDefaultBranch } = await import('@dommaker/studio-agent');
  const defaultBranch = getDefaultBranch(repo);
  if (currentBranch !== defaultBranch) {
    return { ok: false, reason: 'checkout-mismatch', detail: `仓库当前检出 ${currentBranch}，不是默认分支 ${defaultBranch}——拒绝在不干净的主仓上交付` };
  }

  try {
    await execFileAsync('git', ['-C', repo, 'merge', '--no-ff', '-m', message, '--', branch], { cwd: repo, timeout: MERGE_TIMEOUT_MS });
  } catch (err) {
    let conflictFiles: string[] = [];
    try {
      const stdout = await execFileAsync('git', ['-C', repo, 'diff', '--name-only', '--diff-filter=U'], { cwd: repo, timeout: GIT_OP_TIMEOUT_MS });
      conflictFiles = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* best-effort */ }
    return {
      ok: false,
      reason: 'conflict',
      conflictFiles,
      detail: `交付合并冲突（PMO 分支与默认分支分叉），请人工解决: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
    };
  }

  let deliverCommit = '';
  try {
    const stdout = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'], { cwd: repo, timeout: GIT_OP_TIMEOUT_MS });
    deliverCommit = stdout.trim();
  } catch (err) {
    return { ok: false, reason: 'conflict', detail: `交付合并后无法读取 HEAD，未写交付回执: ${getErrorMessage(err)}` };
  }
  if (!deliverCommit) {
    return { ok: false, reason: 'conflict', detail: '交付合并后 HEAD 为空，未写交付回执' };
  }
  return { ok: true, deliverCommit };
}

/**
 * #469：交付成功频道播报（+持久通知）——pmoNumber + commit 短哈希 + 腿数 + 操作人。
 * best-effort（postProjectMilestone 内部逐面兜底），不阻断交付主路径。
 */
async function broadcastDelivered(
  status: Pick<DeliveryStatus, 'projectId' | 'pmoNumber' | 'channelId'>,
  deliverCommit: string,
  by: string,
  legCount: number,
  fileStore?: FileStore,
): Promise<void> {
  const short = deliverCommit ? deliverCommit.slice(0, 7) : '(无 commit)';
  await postProjectMilestone(
    { id: status.projectId, pmoNumber: status.pmoNumber, channelId: status.channelId },
    {
      title: `${status.pmoNumber} 已交付`,
      content: `📦 ${status.pmoNumber} 已交付：commit ${short} · ${legCount} 条交付腿 · 操作人 ${by}`,
    },
    { fileStore },
  );
}

/**
 * auto-merge 交付：证据齐 → PMO 分支合入默认分支（本地，不 push）；缺证据硬性拒绝。
 * 防打扰闸：gitRepo 当前 checkout 必须是默认分支，否则拒绝（人不欠 studio 一个干净主仓）。
 * #113 T7：多腿逐腿独立合并/落档（一腿失败不阻断他腿，成功的腿照样翻 delivered），
 * 全腿交付才写项目级 deliveredAt；单腿行为与现状一致。
 */
export async function deliverProject(
  projectId: string,
  by: string,
  fileStore?: FileStore,
  deps?: DeliveryDeps,
): Promise<DeliverOutcome> {
  const initial = await loadDeliveryStatus(projectId, fileStore, deps);
  if (!initial) return { delivered: false, reason: 'not-found' };
  const { status } = initial;
  if (status.policy === 'branch-only') {
    return { delivered: false, reason: 'branch-only', missing: status.missing, detail: `分支交付模式：请自行合并分支 ${status.branch ?? '(未设置)'} 并走下游发布链路` };
  }
  const initialPending = mergePendingIds(initial.snapshots);
  if (initialPending.length > 0) {
    return { delivered: false, reason: 'merge-pending', detail: `同腿合并未决：${initialPending.join(', ')}` };
  }
  if (!status.deliverable) {
    return { delivered: false, reason: 'not-ready', missing: status.missing };
  }
  const invalidBranch = (status.legs ?? [{ branch: status.branch }]).find(leg => leg.branch && !isValidGitBranch(leg.branch));
  if (invalidBranch) {
    return { delivered: false, reason: 'conflict', detail: `非法 PMO 分支名，拒绝交付: ${invalidBranch.branch}` };
  }
  // 多腿在各自锁内按本腿授权失败，保持逐腿独立；单腿可在任何 Git 前直接拒绝。
  const mandateRejection = status.legs ? null : findProjectMandateRejection(initial.project, initial.snapshots, 'deliver');
  if (mandateRejection) return { delivered: false, reason: 'mandate-rejected', detail: mandateRejection };

  const withLegLock = resolveLegLocker(fileStore, deps);
  const updateProject = deps?.updateProject
    ?? (async (id: string, input: Record<string, unknown>) => projectService.update(id, input));

  // #113 T7 多腿：逐腿合并（已 delivered 腿幂等跳过，零 WU 腿无活可交跳过）
  if (status.legs) {
    const now = new Date().toISOString();
    const results: LegDeliverResult[] = [];
    const newLegs: DeliveryLeg[] = [];
    for (const leg of status.legs) {
      if (leg.status === LEG_STATUS.DELIVERED) {
        results.push({
          gitRepo: leg.gitRepo, branch: leg.branch, delivered: true, reason: 'already-delivered',
          ...(leg.deliverCommit ? { deliverCommit: leg.deliverCommit } : {}),
        });
        newLegs.push({
          gitRepo: leg.gitRepo, branch: leg.branch, status: leg.status,
          deliveredAt: leg.deliveredAt, deliverCommit: leg.deliverCommit,
        });
        continue;
      }
      if (leg.wu.total === 0) {
        results.push({ gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'skipped-no-wu' });
        newLegs.push({ gitRepo: leg.gitRepo, branch: leg.branch, status: leg.status });
        continue;
      }
      if (!leg.gitRepo || !leg.branch) {
        results.push({ gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'no-repo', detail: '腿缺 gitRepo/branch，无法执行合并' });
        newLegs.push({ gitRepo: leg.gitRepo, branch: leg.branch, status: leg.status });
        continue;
      }

      let result: LegDeliverResult;
      let nextLeg: DeliveryLeg = { gitRepo: leg.gitRepo, branch: leg.branch, status: leg.status };
      try {
        await withLegLock(leg.gitRepo, leg.branch, async () => {
          const latest = await loadDeliveryStatus(projectId, fileStore, deps, true);
          const latestLeg = latest?.status.legs?.find(candidate => candidate.gitRepo === leg.gitRepo && candidate.branch === leg.branch);
          if (!latest || !latestLeg) {
            result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'conflict', detail: '交付腿在复核时消失' };
            return;
          }
          const pending = mergePendingIds(legSnapshots(latest.project, latest.snapshots, latestLeg));
          if (pending.length > 0) {
            result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'merge-pending', detail: `同腿合并未决：${pending.join(', ')}` };
            return;
          }
          if (latestLeg.status === LEG_STATUS.DELIVERED) {
            result = {
              gitRepo: leg.gitRepo, branch: leg.branch, delivered: true, reason: 'already-delivered',
              ...(latestLeg.deliverCommit ? { deliverCommit: latestLeg.deliverCommit } : {}),
            };
            nextLeg = {
              gitRepo: leg.gitRepo, branch: leg.branch, status: latestLeg.status,
              deliveredAt: latestLeg.deliveredAt, deliverCommit: latestLeg.deliverCommit,
            };
            return;
          }
          if (!latestLeg.deliverable) {
            result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'not-ready', detail: latestLeg.missing.join('；') };
            return;
          }
          const rejection = findMandateRejection(
            legSnapshots(latest.project, latest.snapshots, latestLeg),
            'deliver',
            { repo: latestLeg.gitRepo!, leg: latestLeg.branch! },
          );
          if (rejection) {
            result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'mandate-rejected', detail: rejection };
            return;
          }

          const merge = await mergeBranchIntoDefault(latestLeg.gitRepo!, latestLeg.branch!, `deliver: ${status.pmoNumber} [${latestLeg.branch}]`, deps?.withRepo);
          if (merge.ok === true) {
            result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: true, deliverCommit: merge.deliverCommit };
            nextLeg = { gitRepo: leg.gitRepo, branch: leg.branch, status: LEG_STATUS.DELIVERED, deliveredAt: now, deliverCommit: merge.deliverCommit };
          } else {
            result = {
              gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: merge.reason,
              ...(merge.conflictFiles ? { conflictFiles: merge.conflictFiles } : {}),
              ...(merge.detail ? { detail: merge.detail } : {}),
            };
          }
        });
      } catch (err) {
        if (!(err instanceof LockTimeoutError)) throw err;
        result = { gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: 'merge-pending', detail: '同腿 Git 操作进行中' };
      }
      results.push(result!);
      newLegs.push(nextLeg);
    }

    const allSatisfied = results.every(r => r.delivered || r.reason === 'skipped-no-wu');
    const lastCommit = [...results].reverse().find(r => r.deliverCommit)?.deliverCommit ?? '';
    if (allSatisfied) {
      await updateProject(projectId, {
        deliveries: newLegs,
        deliveredAt: now,
        deliveredBy: by,
        deliverCommit: lastCommit,
      });
      await broadcastDelivered(status, lastCommit, by, status.legs.length, fileStore);
      return { delivered: true, deliverCommit: lastCommit, legs: results };
    }

    await updateProject(projectId, { deliveries: newLegs });
    const firstFailure = results.find(r => !r.delivered && r.reason !== 'skipped-no-wu')!;
    const reason = firstFailure.reason === 'no-repo' || firstFailure.reason === 'checkout-mismatch'
      || firstFailure.reason === 'merge-pending' || firstFailure.reason === 'not-ready'
      || firstFailure.reason === 'mandate-rejected'
      ? firstFailure.reason
      : 'conflict';
    return {
      delivered: false,
      reason,
      ...(firstFailure.conflictFiles ? { conflictFiles: firstFailure.conflictFiles } : {}),
      ...(firstFailure.detail ? { detail: firstFailure.detail } : {}),
      legs: results,
    };
  }

  if (!status.gitRepo || !status.branch) {
    return { delivered: false, reason: 'no-repo' };
  }

  try {
    return await withLegLock(status.gitRepo, status.branch, async () => {
      const latest = await loadDeliveryStatus(projectId, fileStore, deps, true);
      if (!latest) return { delivered: false as const, reason: 'not-found' as const };
      const pending = mergePendingIds(latest.snapshots);
      if (pending.length > 0) {
        return { delivered: false as const, reason: 'merge-pending' as const, detail: `同腿合并未决：${pending.join(', ')}` };
      }
      if (!latest.status.deliverable) {
        return { delivered: false as const, reason: 'not-ready' as const, missing: latest.status.missing };
      }
      if (latest.project.deliveredAt) {
        return { delivered: true as const, deliverCommit: latest.project.deliverCommit ?? '' };
      }
      if (!latest.status.gitRepo || !latest.status.branch) {
        return { delivered: false as const, reason: 'no-repo' as const };
      }
      const rejection = findProjectMandateRejection(latest.project, latest.snapshots, 'deliver');
      if (rejection) return { delivered: false as const, reason: 'mandate-rejected' as const, detail: rejection };

      const merge = await mergeBranchIntoDefault(latest.status.gitRepo, latest.status.branch, `deliver: ${status.pmoNumber}`, deps?.withRepo);
      if (merge.ok === false) {
        return {
          delivered: false as const,
          reason: merge.reason,
          ...(merge.conflictFiles ? { conflictFiles: merge.conflictFiles } : {}),
          ...(merge.detail ? { detail: merge.detail } : {}),
        };
      }

      await updateProject(projectId, {
        deliveredAt: new Date().toISOString(),
        deliveredBy: by,
        deliverCommit: merge.deliverCommit,
      });
      await broadcastDelivered(latest.status, merge.deliverCommit, by, 1, fileStore);
      return { delivered: true as const, deliverCommit: merge.deliverCommit };
    });
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    return { delivered: false, reason: 'merge-pending', detail: '同腿 Git 操作进行中' };
  }
}

// ============================================
// #469：branch-only 标记已交付（人工落档）
// ============================================

export type MarkDeliveredOutcome =
  | { marked: true; deliverCommit: string; deliveredAt: string }
  | { marked: false; reason: 'not-found' | 'not-branch-only' | 'already-delivered' | 'merge-pending' | 'mandate-rejected'; detail?: string };

/**
 * branch-only 交付闭环：系统外合并发生后，人工把 commit 哈希落档。
 * 不设证据闸——人是系统外交付的权威；但同腿仍有持久 merge intent / 未结束验证时
 * 必须拒绝，避免人工回执覆盖系统内尚未落定的真实 Git 状态。多腿锁按身份排序获取。
 */
export async function markProjectDelivered(
  projectId: string,
  by: string,
  commit: string,
  fileStore?: FileStore,
  deps?: DeliveryDeps,
): Promise<MarkDeliveredOutcome> {
  const initial = await loadDeliveryStatus(projectId, fileStore, deps);
  if (!initial) return { marked: false, reason: 'not-found' };
  if (resolveDeliveryPolicy(initial.project) !== 'branch-only') {
    return { marked: false, reason: 'not-branch-only', detail: 'auto-merge 项目请走交付合并（deliver），无需人工落档' };
  }
  if (initial.project.deliveredAt) {
    return { marked: false, reason: 'already-delivered', detail: `已于 ${initial.project.deliveredAt} 落档（commit ${initial.project.deliverCommit ?? '未知'}），不重复标记` };
  }
  const initialPending = mergePendingIds(initial.snapshots);
  if (initialPending.length > 0) {
    return { marked: false, reason: 'merge-pending', detail: `同腿合并未决：${initialPending.join(', ')}` };
  }
  const mandateRejection = findProjectMandateRejection(initial.project, initial.snapshots, 'mark-delivered');
  if (mandateRejection) return { marked: false, reason: 'mandate-rejected', detail: mandateRejection };

  const withLegLock = resolveLegLocker(fileStore, deps);
  const legs = resolveDeliveries(initial.project)
    .filter((leg): leg is DeliveryLeg & { gitRepo: string; branch: string } => Boolean(leg.gitRepo && leg.branch))
    .sort((a, b) => `${a.gitRepo}\0${a.branch}`.localeCompare(`${b.gitRepo}\0${b.branch}`));
  const updateProject = deps?.updateProject
    ?? (async (id: string, input: Record<string, unknown>) => projectService.update(id, input));

  const markAfterLocks = async (index: number): Promise<MarkDeliveredOutcome> => {
    if (index < legs.length) {
      const leg = legs[index];
      return withLegLock(leg.gitRepo, leg.branch, () => markAfterLocks(index + 1));
    }
    const latest = await loadDeliveryStatus(projectId, fileStore, deps, true);
    if (!latest) return { marked: false, reason: 'not-found' };
    if (latest.project.deliveredAt) {
      return { marked: false, reason: 'already-delivered', detail: `已于 ${latest.project.deliveredAt} 落档，不重复标记` };
    }
    const pending = mergePendingIds(latest.snapshots);
    if (pending.length > 0) {
      return { marked: false, reason: 'merge-pending', detail: `同腿合并未决：${pending.join(', ')}` };
    }
    const rejection = findProjectMandateRejection(latest.project, latest.snapshots, 'mark-delivered');
    if (rejection) return { marked: false, reason: 'mandate-rejected', detail: rejection };

    const deliveredAt = new Date().toISOString();
    await updateProject(projectId, { deliveredAt, deliveredBy: by, deliverCommit: commit });
    await broadcastDelivered(
      { projectId: latest.project.id, pmoNumber: latest.project.pmoNumber, channelId: latest.project.channelId ?? null },
      commit,
      by,
      resolveDeliveries(latest.project).length,
      fileStore,
    );
    return { marked: true, deliverCommit: commit, deliveredAt };
  };

  try {
    return await markAfterLocks(0);
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    return { marked: false, reason: 'merge-pending', detail: '同腿 Git 操作进行中' };
  }
}
