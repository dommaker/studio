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
 * l1 只对代码类 WU（task/bug/feature/refactor）要求；l2 豁免 review/analysis
 * （dispatcher 不派评审，验收闸是人工 L3）；l3 对所有已完成 WU 要求。
 */
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { projectService, resolveDeliveryPolicy, type DeliveryPolicy, type ProjectData } from './project.service.js';
import { RequirementService } from '../requirements/requirement.service.js';
import { selectProjectSnapshots, summarizeEvidence } from './evidence-summary.js';
import { sumTokensForWorkUnits } from '../agents/token-usage.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';

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
  /** 可交付 = 有 WU 且全部完成且证据齐（l1 限代码类，l2 豁免 review/analysis） */
  deliverable: boolean;
  /** 人话缺口清单（branch-only 标记 / auto-merge 拒绝原因共用） */
  missing: string[];
  /** 项目 WU 链路 token 总消耗（studio-events.jsonl 的 workunit:tokens 事件求和，best-effort） */
  tokens: number;
  /** 已完成但证据有缺口的 WU 明细（供前端渲染行动清单；missing 顺序固定 l1→l2→l3） */
  gaps: Array<{ id: string; title: string; type: string; missing: Array<'l1' | 'l2' | 'l3'> }>;
  deliveredAt: string | null;
  deliveredBy: string | null;
  deliverCommit: string | null;
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

/** PMO 台账：WU 汇总 + 证据齐缺（只读，无任何副作用） */
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
  const summary = summarizeEvidence(snapshots);
  const { l1Missing, l2Missing, l3Missing, selfReviewCount, deliverable } = summary;
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
  const sumTokens = deps?.sumTokens ?? sumTokensForWorkUnits;
  const tokens = await sumTokens(new Set(snapshots.map(s => s.id))).catch(() => 0);

  const missing: string[] = [];
  if (snapshots.length === 0) missing.push('无关联 WorkUnit');
  if (inFlight > 0) missing.push(`${inFlight} 个 WorkUnit 未完成`);
  if (l1Missing.length > 0) missing.push(`${l1Missing.length} 个代码类 WorkUnit 缺 L1 自动验证（${l1Missing.slice(0, 3).join(', ')}${l1Missing.length > 3 ? '…' : ''}）`);
  if (l2Missing.length > 0) missing.push(`${l2Missing.length} 个 WorkUnit 缺 L2 agent 评审（${l2Missing.slice(0, 3).join(', ')}${l2Missing.length > 3 ? '…' : ''}）`);
  if (l3Missing.length > 0) missing.push(`${l3Missing.length} 个 WorkUnit 缺 L3 人工确认（${l3Missing.slice(0, 3).join(', ')}${l3Missing.length > 3 ? '…' : ''}）`);

  return {
    projectId: project.id,
    pmoNumber: project.pmoNumber,
    branch: project.gitBranch || project.pmoNumber || null,
    policy: resolveDeliveryPolicy(project),
    gitRepo: project.gitRepo ?? null,
    wu: { total: summary.total, finished: summary.finished, inFlight, byStatus: summary.byStatus },
    evidence: { l1Missing, l2Missing, l3Missing, selfReviewCount },
    deliverable,
    missing,
    tokens,
    gaps,
    deliveredAt: project.deliveredAt ?? null,
    deliveredBy: project.deliveredBy ?? null,
    deliverCommit: project.deliverCommit ?? null,
  };
}

export type DeliverOutcome =
  | { delivered: true; deliverCommit: string }
  | { delivered: false; reason: 'branch-only' | 'not-ready' | 'no-repo' | 'checkout-mismatch' | 'conflict' | 'not-found'; missing?: string[]; conflictFiles?: string[]; detail?: string };

/**
 * auto-merge 交付：证据齐 → PMO 分支合入默认分支（本地，不 push）；缺证据硬性拒绝。
 * 防打扰闸：gitRepo 当前 checkout 必须是默认分支，否则拒绝（人不欠 studio 一个干净主仓）。
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
  if (!status.gitRepo || !status.branch) {
    return { delivered: false, reason: 'no-repo' };
  }

  const repo = status.gitRepo;
  let currentBranch = '';
  try {
    const { stdout } = await execSh(`git -C ${shq(repo)} rev-parse --abbrev-ref HEAD`, { cwd: repo, timeoutMs: GIT_OP_TIMEOUT_MS });
    currentBranch = stdout.trim();
  } catch (err) {
    return { delivered: false, reason: 'no-repo', detail: `git 仓库不可用: ${err instanceof Error ? err.message : String(err)}` };
  }
  // 交付目标 = 默认分支探测（origin/HEAD → main → master），与 worktree 机器同口径
  const { getDefaultBranch } = await import('@dommaker/studio-agent');
  const defaultBranch = getDefaultBranch(repo);
  if (currentBranch !== defaultBranch) {
    return { delivered: false, reason: 'checkout-mismatch', detail: `仓库当前检出 ${currentBranch}，不是默认分支 ${defaultBranch}——拒绝在不干净的主仓上交付` };
  }

  try {
    await execSh(
      `git -C ${shq(repo)} merge --no-ff ${shq(status.branch)} -m ${shq(`deliver: ${status.pmoNumber}`)}`,
      { cwd: repo, timeoutMs: MERGE_TIMEOUT_MS },
    );
  } catch (err) {
    let conflictFiles: string[] = [];
    try {
      const { stdout } = await execSh(`git -C ${shq(repo)} diff --name-only --diff-filter=U`, { cwd: repo, timeoutMs: GIT_OP_TIMEOUT_MS });
      conflictFiles = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    } catch { /* best-effort */ }
    return {
      delivered: false,
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

  const updateProject = deps?.updateProject
    ?? (async (id: string, input: Record<string, unknown>) => projectService.update(id, input));
  await updateProject(projectId, {
    deliveredAt: new Date().toISOString(),
    deliveredBy: by,
    deliverCommit,
  });

  return { delivered: true, deliverCommit };
}
