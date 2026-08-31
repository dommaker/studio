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
 * （dispatcher 不派评审，验收闸是人工 L3）；l3 对所有已完成 WU 要求。
 *
 * #113 T7（#106 子票）：显式多腿项目（resolveDeliveries > 1）按腿循环——台账/证据齐缺/
 * deliverable 判定/auto-merge 逐腿独立；WU→腿归属走 evidence-summary 的 matchWuToLeg
 * （workspaceRoot/worktreeBaseRepo 命中腿 gitRepo，或 pmoBranch 命中腿 branch），
 * 未分腿公共 WU 保守计入每条腿。整体 deliverable = 全部腿 deliverable（零 WU 腿不阻断，
 * 全项目无 WU 仍不可交付）；auto-merge 全腿交付才写项目级 deliveredAt。
 * 单腿（无 deliveries / 合成单腿）：不输出 legs 字段，行为与现状逐字节一致。
 */
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { projectService, resolveDeliveries, resolveDeliveryPolicy, LEG_STATUS, type DeliveryLeg, type DeliveryLegStatus, type DeliveryPolicy, type ProjectData } from './project.service.js';
import { RequirementService } from '../requirements/requirement.service.js';
import { selectProjectSnapshots, summarizeEvidence, partitionSnapshotsByLeg, type EvidenceSummary } from './evidence-summary.js';
import { sumTokensForWorkUnits } from '../agents/token-usage.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { getErrorMessage } from '../../utils/errors.js';

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
    /** l2 中自评数（决策 5：评审独立性参考，不阻断交付） */
    selfReviewCount: number;
  };
  /** 可交付 = 有 WU 且全部完成且证据齐（l1 限代码类，l2 豁免 review/analysis/decision/spec）；多腿 = 全部腿 deliverable */
  deliverable: boolean;
  /** 人话缺口清单（branch-only 标记 / auto-merge 拒绝原因共用；多腿逐腿带 [分支] 前缀） */
  missing: string[];
  /** 项目 WU 链路 token 总消耗（studio-events.jsonl 的 workunit:tokens 事件求和，best-effort） */
  tokens: number;
  /** 已完成但证据有缺口的 WU 明细（供前端渲染行动清单；missing 顺序固定 l1→l2→l3） */
  gaps: Array<{ id: string; title: string; type: string; missing: Array<'l1' | 'l2' | 'l3'> }>;
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliverCommit: string | null;
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
  listRequirements?: () => Promise<Array<{ id: string; projectId?: string | null }>>;
  getIndex?: () => Promise<WorkUnitSnapshot[]>;
  updateProject?: (id: string, input: Record<string, unknown>) => Promise<ProjectData>;
  /** token 聚合注入点（测试用；缺省走 token-usage.service 的 sumTokensForWorkUnits） */
  sumTokens?: (workUnitIds: Set<string>) => Promise<number>;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  const { l1Missing, l2Missing, l3Missing } = summary;
  const inFlight = summary.inFlight;

  // gaps：已完成但有证据缺口的 WU 明细（missing 顺序固定 l1→l2→l3，供前端渲染行动清单）
  const missingByWu = new Map<string, Array<'l1' | 'l2' | 'l3'>>();
  const pushGap = (id: string, level: 'l1' | 'l2' | 'l3') => {
    const arr = missingByWu.get(id) ?? [];
    arr.push(level);
    missingByWu.set(id, arr);
  };
  for (const id of l1Missing) pushGap(id, 'l1');
  for (const id of l2Missing) pushGap(id, 'l2');
  for (const id of l3Missing) pushGap(id, 'l3');
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

  return { summary, missing, gaps, tokens };
}

/** PMO 台账：WU 汇总 + 证据齐缺（只读，无任何副作用）；多腿项目附逐腿台账 */
export async function getDeliveryStatus(
  projectId: string,
  fileStore?: FileStore,
  deps?: DeliveryDeps,
): Promise<DeliveryStatus | null> {
  const getProject = deps?.getProject ?? (async (id: string) => projectService.get(id));
  const project = await getProject(projectId);
  if (!project) return null;

  const fs = fileStore ?? new FileStore();
  const listRequirements = deps?.listRequirements
    ?? (async () => new RequirementService(fs).list());
  const getIndex = deps?.getIndex ?? (async () => fs.getIndex());

  const snapshots = selectProjectSnapshots(projectId, await listRequirements(), await getIndex());
  const sumTokens = deps?.sumTokens ?? sumTokensForWorkUnits;
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
      selfReviewCount: summary.selfReviewCount,
    },
    deliverable,
    missing,
    tokens: ledger.tokens,
    gaps: ledger.gaps,
    deliveredAt: project.deliveredAt ?? null,
    deliveredBy: project.deliveredBy ?? null,
    deliverCommit: project.deliverCommit ?? null,
    ...(legStatuses ? { legs: legStatuses } : {}),
  };
}

/** #113 T7：单腿交付结果（多腿 deliverProject 逐腿产出） */
export interface LegDeliverResult {
  gitRepo: string | null;
  branch: string | null;
  delivered: boolean;
  reason?: 'already-delivered' | 'skipped-no-wu' | 'no-repo' | 'checkout-mismatch' | 'conflict';
  deliverCommit?: string;
  conflictFiles?: string[];
  detail?: string;
}

export type DeliverOutcome =
  | { delivered: true; deliverCommit: string; legs?: LegDeliverResult[] }
  | { delivered: false; reason: 'branch-only' | 'not-ready' | 'no-repo' | 'checkout-mismatch' | 'conflict' | 'not-found'; missing?: string[]; conflictFiles?: string[]; detail?: string; legs?: LegDeliverResult[] };

type MergeResult =
  | { ok: true; deliverCommit: string }
  | { ok: false; reason: 'no-repo' | 'checkout-mismatch' | 'conflict'; conflictFiles?: string[]; detail?: string };

/**
 * 单仓库合并：当前 checkout 必须是默认分支（防打扰闸，人不欠 studio 一个干净主仓），
 * 然后 branch → 默认分支本地合并（--no-ff，不 push）；冲突不自动 rebase，转人工。
 */
async function mergeBranchIntoDefault(repo: string, branch: string, message: string): Promise<MergeResult> {
  let currentBranch = '';
  try {
    const { stdout } = await execSh(`git -C ${shq(repo)} rev-parse --abbrev-ref HEAD`, { cwd: repo, timeoutMs: GIT_OP_TIMEOUT_MS });
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
    await execSh(
      `git -C ${shq(repo)} merge --no-ff ${shq(branch)} -m ${shq(message)}`,
      { cwd: repo, timeoutMs: MERGE_TIMEOUT_MS },
    );
  } catch (err) {
    let conflictFiles: string[] = [];
    try {
      const { stdout } = await execSh(`git -C ${shq(repo)} diff --name-only --diff-filter=U`, { cwd: repo, timeoutMs: GIT_OP_TIMEOUT_MS });
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
    const { stdout } = await execSh(`git -C ${shq(repo)} rev-parse HEAD`, { cwd: repo, timeoutMs: GIT_OP_TIMEOUT_MS });
    deliverCommit = stdout.trim();
  } catch { /* 空字符串兜底 */ }
  return { ok: true, deliverCommit };
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
  const status = await getDeliveryStatus(projectId, fileStore, deps);
  if (!status) return { delivered: false, reason: 'not-found' };
  if (status.policy === 'branch-only') {
    return { delivered: false, reason: 'branch-only', missing: status.missing, detail: `分支交付模式：请自行合并分支 ${status.branch ?? '(未设置)'} 并走下游发布链路` };
  }
  if (!status.deliverable) {
    return { delivered: false, reason: 'not-ready', missing: status.missing };
  }

  const updateProject = deps?.updateProject
    ?? (async (id: string, input: Record<string, unknown>) => projectService.update(id, input));

  // #113 T7 多腿：逐腿合并（已 delivered 腿幂等跳过，零 WU 腿无活可交跳过）
  if (status.legs) {
    const now = new Date().toISOString();
    const results: LegDeliverResult[] = [];
    const newLegs: DeliveryLeg[] = [];
    for (const leg of status.legs) {
      if (leg.status === LEG_STATUS.DELIVERED) {
        // 幂等跳过：不重复合并，原腿级落档字段保真透传
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
      const merge = await mergeBranchIntoDefault(leg.gitRepo, leg.branch, `deliver: ${status.pmoNumber} [${leg.branch}]`);
      // 注：本包 tsconfig 未开 strict，可辨识联合须用 === 字面量比较收窄（routes.ts 同款）
      if (merge.ok === true) {
        results.push({ gitRepo: leg.gitRepo, branch: leg.branch, delivered: true, deliverCommit: merge.deliverCommit });
        newLegs.push({ gitRepo: leg.gitRepo, branch: leg.branch, status: LEG_STATUS.DELIVERED, deliveredAt: now, deliverCommit: merge.deliverCommit });
      } else {
        results.push({
          gitRepo: leg.gitRepo, branch: leg.branch, delivered: false, reason: merge.reason,
          ...(merge.conflictFiles ? { conflictFiles: merge.conflictFiles } : {}),
          ...(merge.detail ? { detail: merge.detail } : {}),
        });
        newLegs.push({ gitRepo: leg.gitRepo, branch: leg.branch, status: leg.status });
      }
    }

    // 整体交付 = 每腿 delivered 或无活可交（skipped-no-wu）
    const allSatisfied = results.every(r => r.delivered || r.reason === 'skipped-no-wu');
    const lastCommit = [...results].reverse().find(r => r.deliverCommit)?.deliverCommit ?? '';
    if (allSatisfied) {
      await updateProject(projectId, {
        deliveries: newLegs,
        deliveredAt: now,
        deliveredBy: by,
        deliverCommit: lastCommit,
      });
      return { delivered: true, deliverCommit: lastCommit, legs: results };
    }

    // 部分失败：成功的腿独立落档 delivered，项目级交付记录不写
    await updateProject(projectId, { deliveries: newLegs });
    const firstFailure = results.find(r => !r.delivered && r.reason !== 'skipped-no-wu')!;
    return {
      delivered: false,
      reason: firstFailure.reason === 'no-repo' ? 'no-repo' : firstFailure.reason === 'checkout-mismatch' ? 'checkout-mismatch' : 'conflict',
      ...(firstFailure.conflictFiles ? { conflictFiles: firstFailure.conflictFiles } : {}),
      ...(firstFailure.detail ? { detail: firstFailure.detail } : {}),
      legs: results,
    };
  }

  if (!status.gitRepo || !status.branch) {
    return { delivered: false, reason: 'no-repo' };
  }

  const merge = await mergeBranchIntoDefault(status.gitRepo, status.branch, `deliver: ${status.pmoNumber}`);
  if (merge.ok === false) {
    return {
      delivered: false,
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

  return { delivered: true, deliverCommit: merge.deliverCommit };
}
