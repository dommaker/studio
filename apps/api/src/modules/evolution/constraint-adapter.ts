/**
 * constraint-adapter（ADR-0033 块 3 子项 7/8）— 约束生命周期提案 adapter
 * （review-proposal 正本新 kind `constraint`，cardType `constraint_proposal`）。
 *
 * 与 kind='evolution'（review-adapter.ts，退休/调参等存量约束演进）分工：
 * evolution 管「既有内置约束的退休/禁用」；本 adapter 管「两层约束」的两个新动作：
 *   - action='new'（子项 7）：知识→约束。runScan 查知识库带 `constraintCandidate`
 *     标签的条目（harness ≥1.12.0 升 proven 时自动打标），产「新约束提案」卡；
 *     approve → 追加进目标仓 `.harness/constraints.yml`（append，不动既有条目）
 *     + git commit 留痕（trailer `Governance-Approved: <提案号>`，同退休 applier 口径）。
 *   - action='upgrade'（子项 8）：应用层→通用层升级提案，见 propose-upgrade 端点
 *     （harness/constraints.routes.ts）；approve → spawn harness `constraints pack-proposal`。
 *
 * 防重复提案：提案记录本身即消耗标记——扫描时跳过已有任何状态提案引用的 entryId
 * （含已驳回：人判不做约束即终局，不再骚扰），不回写知识条目。
 *
 * 存储：正本默认物化 `<dataDir>/constraint-proposals.jsonl`（无形态例外，
 * 不走 evolution EP-XXXX.json 自定义 store）。卡不支持编辑（不发明新交互）：
 * checker/参数推断不出 → 卡面标「待确认」，onApprove 以 aborted 拒落盘
 * （参数残缺的条目会让 harness 加载期抛错，不能写进 constraints.yml）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { getEffectiveConstraints, type KnowledgeEntry } from '@dommaker/harness';
import { FileStore, logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import {
  getReviewProposalAdapter,
  registerReviewProposalAdapter,
  type ApproveOutcome,
  type ReviewProposalAdapter,
} from '../review-proposal/index.js';
import { submitProposal } from '../review-proposal/index.js';
import { resolveHarnessBin, runCmd } from './applier.js';

/** 约束提案载荷（行形态：{ kind:'proposal', ... } 落 constraint-proposals.jsonl） */
export interface ConstraintProposal {
  id: string;
  createdAt: string;
  /** new = 知识→新约束（子项 7）；upgrade = 应用层→通用层（子项 8） */
  action: 'new' | 'upgrade';
  /** 目标仓根（绝对路径，约束生效落点仓） */
  repoRoot: string;
  /** 约束 id（app_ 前缀；new=新建 id，upgrade=既有应用层 id） */
  constraintId: string;
  /** 约束条文（卡面草稿，approve 即按卡面落定） */
  rule: string;
  /** checker 模板 id；无法从知识条目推断 → null（卡面标「待确认」，不可批准落盘） */
  checker: 'regex-scan' | 'file-exists' | null;
  /** checker 参数草稿（模板口径见 harness templated checkers） */
  params: Record<string, unknown>;
  severity: 'error' | 'warning' | 'info';
  /** 违规提示文案（草稿） */
  message: string;
  /** 使用统计白话句（action='upgrade' 卡面展示，如「累计评估 60 次，拦到 0 次」） */
  statsText?: string;
  /** 来源知识条目（action='new' 必有；其 id 兼作防重复提案消耗标记键） */
  sourceEntry?: { id: string; title: string };
}

/** 每轮扫描最多产出的新约束提案数（保守原则，同 generator (a) 链路口径） */
const MAX_NEW_CONSTRAINT_PROPOSALS_PER_RUN = 3;

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** 约束 id 草稿：app_ + 标题 slug（纯中文标题 slug 为空 → 退 entry id 兜底） */
export function draftConstraintId(entry: { id: string; title: string }): string {
  const slug = entry.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  const base = slug || entry.id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `app_${base || 'unnamed'}`;
}

/** 正则元字符探测：内容里的 inline-code/代码围栏 token 像正则且可编译 → 预填 regex-scan 草稿 */
const REGEX_META = /[\^$\\[\]()+?|{}]/;

export function inferCheckerDraft(content: string): Pick<ConstraintProposal, 'checker' | 'params'> {
  const tokens: string[] = [];
  for (const m of content.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)) tokens.push(...m[1].split('\n'));
  for (const m of content.matchAll(/`([^`\n]+)`/g)) tokens.push(m[1]);
  for (const t of tokens) {
    const cand = t.trim();
    if (!cand || cand.length > 200 || !REGEX_META.test(cand)) continue;
    try {
      // eslint-disable-next-line no-new
      new RegExp(cand);
      return { checker: 'regex-scan', params: { pattern: cand } };
    } catch { /* 不可编译 → 下一个候选 */ }
  }
  return { checker: null, params: {} };
}

/** checker 参数完备性校验（与 harness 模板 validateParams 同口径的最小集；残缺条目落盘会让加载期抛错） */
function checkerParamsReady(p: ConstraintProposal): string | null {
  if (!p.checker) return 'checker 模板待确认（无法从知识条目推断），请人工补全后改走手工落盘，或 reject 本卡';
  if (p.checker === 'regex-scan') {
    if (typeof p.params.pattern !== 'string' || p.params.pattern.length === 0) {
      return 'regex-scan 参数 pattern 待确认';
    }
    return null;
  }
  // file-exists：path 与 glob 至少填一个
  if (typeof p.params.path !== 'string' && typeof p.params.glob !== 'string') {
    return 'file-exists 参数 path/glob 待确认（至少填一个）';
  }
  return null;
}

/** 应用层约束文件（ADR-0033 §1）：<repoRoot>/.harness/constraints.yml，constraints 为条目列表 */
interface AppConstraintsFile {
  constraints?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

function readAppConstraints(file: string): AppConstraintsFile {
  if (!fs.existsSync(file)) return {};
  const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as AppConstraintsFile | null) ?? {};
  if (raw.constraints !== undefined && !Array.isArray(raw.constraints)) {
    throw new Error(`${file} 的 constraints 段不是列表（文件损坏，不静默放行）`);
  }
  return raw;
}

/**
 * action='new' 落盘：追加进 <repoRoot>/.harness/constraints.yml + git commit 留痕。
 * 纪律与退休 applier 同形：写前备份、写后验证（getEffectiveConstraints 必须能加载且含新 id，
 * 加载抛错 = 参数/schema 坏 → 回滚）、失败回滚备份；commit 失败降级 warn 不阻断。
 */
async function applyNewConstraint(p: ConstraintProposal): Promise<{ detail: string; committed?: boolean; sha?: string }> {
  if (!path.isAbsolute(p.repoRoot) || !fs.existsSync(p.repoRoot) || !fs.statSync(p.repoRoot).isDirectory()) {
    throw new Error(`invalid repoRoot: ${p.repoRoot}（必须是存在的绝对路径目录）`);
  }
  const notReady = checkerParamsReady(p);
  if (notReady) throw new Error(`cannot apply incomplete checker draft: ${notReady}`);

  const file = path.join(p.repoRoot, '.harness', 'constraints.yml');
  const raw = readAppConstraints(file);
  const entries = [...(raw.constraints ?? [])];
  if (entries.some(e => e?.id === p.constraintId)) {
    return { detail: `constraint '${p.constraintId}' already present in constraints.yml（幂等短路，未写文件）` };
  }
  entries.push({
    id: p.constraintId,
    rule: p.rule,
    checker: p.checker,
    params: p.params,
    severity: p.severity,
    message: p.message,
  });

  const backupPath = fs.existsSync(file)
    ? `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;
  if (backupPath) fs.copyFileSync(file, backupPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump({ ...raw, constraints: entries }, { lineWidth: 120 }), 'utf-8');

  // 写后验证：生效集加载（含应用层校验：app_ 前缀/模板存在/params schema）+ 新 id 必须在集内；
  // 失败回滚备份（js-yaml 重写不保留原文件注释，与 harness CLI 一致，回滚可还原）
  try {
    const effective = getEffectiveConstraints(p.repoRoot);
    if (!effective.some(c => c.id === p.constraintId)) {
      throw new Error(`constraint '${p.constraintId}' not in effective set after write`);
    }
  } catch (err) {
    if (backupPath) fs.copyFileSync(backupPath, file);
    else fs.rmSync(file, { force: true });
    throw new Error(`constraint write failed verification, restored backup: ${String(err)}`);
  }

  // git commit 留痕（只 add 单文件；失败降级 warn + committed:false，不阻断落盘结果）
  const relPath = '.harness/constraints.yml';
  try {
    const add = await runCmd('git', ['-C', p.repoRoot, 'add', '--', relPath]);
    if (add.code !== 0) throw new Error(`git add failed: ${(add.stderr || add.stdout).slice(0, 300)}`);
    const subject = `chore(evolution): add app constraint ${p.constraintId} (${p.id})`;
    const body = `新约束提案自动生效留痕：${p.id}（新增应用层约束 ${p.constraintId}）\n\nGovernance-Approved: ${p.id}`;
    const commit = await runCmd('git', ['-C', p.repoRoot, 'commit', '-m', subject, '-m', body]);
    if (commit.code !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).slice(0, 300)}`);
    const head = await runCmd('git', ['-C', p.repoRoot, 'rev-parse', 'HEAD']);
    return {
      detail: `appended app constraint '${p.constraintId}' to ${relPath}`,
      committed: true,
      ...(head.code === 0 ? { sha: head.stdout.trim() } : {}),
    };
  } catch (err) {
    logger.warn('[Constraint] constraints.yml 生效留痕 commit 失败（不阻断落盘结果）', { id: p.id, error: String(err) });
    return { detail: `appended app constraint '${p.constraintId}' to ${relPath}（commit 留痕失败）`, committed: false };
  }
}

/**
 * action='upgrade' 落点（子项 8）：spawn 本仓 node_modules harness CLI
 * `constraints pack-proposal <id> -p <repoRoot>`（harness ≥1.12.0；与退休 applier 同一
 * 解析纪律，不走 npx）。材料落 `<repoRoot>/.harness/reports/proposal-<id>-<yyyymmdd>.md`；
 * 跨零点日期边界兜底取同 id 最新材料文件。不自动开 GitHub issue（人工兜底）。
 */
async function applyUpgradeProposal(p: ConstraintProposal): Promise<{ materialPath: string }> {
  if (!path.isAbsolute(p.repoRoot) || !fs.existsSync(p.repoRoot) || !fs.statSync(p.repoRoot).isDirectory()) {
    throw new Error(`invalid repoRoot: ${p.repoRoot}（必须是存在的绝对路径目录）`);
  }
  const res = await runCmd(process.execPath, [
    resolveHarnessBin(), 'constraints', 'pack-proposal', p.constraintId, '-p', p.repoRoot,
  ]);
  if (res.code !== 0) {
    throw new Error(`harness constraints pack-proposal ${p.constraintId} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(0, 400)}`);
  }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(p.repoRoot, '.harness', 'reports');
  let materialPath = path.join(dir, `proposal-${p.constraintId}-${date}.md`);
  if (!fs.existsSync(materialPath)) {
    const candidates = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.startsWith(`proposal-${p.constraintId}-`)).sort()
      : [];
    if (candidates.length === 0) {
      throw new Error(`pack-proposal exit 0 但未找到材料文件（${dir}/proposal-${p.constraintId}-*.md）`);
    }
    materialPath = path.join(dir, candidates[candidates.length - 1]);
  }
  return { materialPath };
}

/** 升级材料回帖 #系统（纯文本 agent 消息；频道缺失/发信失败静默，不阻断 executed 结果） */
async function postUpgradeMaterialNote(
  fileStore: FileStore,
  p: ConstraintProposal,
  materialPath: string,
): Promise<void> {
  try {
    const channel = (await fileStore.listChannels({ name: '#系统' }))[0] ?? null;
    if (!channel) return;
    const head = fs.readFileSync(materialPath, 'utf-8').slice(0, 800);
    const content = [
      `⬆️ 约束升级材料已生成（提案 ${p.id}）`,
      '',
      `约束：${p.constraintId}`,
      `材料：${materialPath}`,
      '',
      '材料摘要：',
      head,
      '',
      '下一步：请人工确认材料无应用内部信息（params 正则/glob 为原文带出），然后拿材料去 harness 仓开 issue——不自动开。',
    ].join('\n');
    const { channelMessageService } = await import('../channels/index.js');
    await channelMessageService.createAgentMessage(channel.id, 'Evolution', content);
  } catch (err) {
    logger.warn('[Constraint] 升级材料回帖失败（不阻断 executed 结果）', { id: p.id, error: String(err) });
  }
}

/** 子项 8 发起侧：建 upgrade 提案 + 发卡（propose-upgrade 端点调用） */
export async function submitConstraintUpgradeProposal(
  adapter: ReviewProposalAdapter<ConstraintProposal>,
  input: {
    repoRoot: string;
    entry: {
      id: string;
      rule: string;
      checker?: string;
      params?: Record<string, unknown>;
      severity?: string;
      message?: string;
    };
    statsText: string;
  },
): Promise<{ proposalId: string; posted: boolean }> {
  const proposal: ConstraintProposal = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    action: 'upgrade',
    repoRoot: input.repoRoot,
    constraintId: input.entry.id,
    rule: input.entry.rule,
    checker: input.entry.checker === 'regex-scan' || input.entry.checker === 'file-exists' ? input.entry.checker : null,
    params: input.entry.params ?? {},
    severity: input.entry.severity === 'error' || input.entry.severity === 'info' ? input.entry.severity : 'warning',
    message: input.entry.message ?? '',
    statsText: input.statsText,
  };
  const { posted } = await submitProposal(adapter, proposal);
  return { proposalId: proposal.id, posted };
}

const CHECKER_LABELS: Record<string, string> = {
  'regex-scan': '正则扫描（regex-scan）',
  'file-exists': '文件存在性（file-exists）',
};

/** 提案卡渲染（白话口径，子项 9 硬要求从首张卡就执行：不摆 k=v 字段名原文） */
export function renderConstraintCard(p: ConstraintProposal): { content: string; cardData: Record<string, unknown> } {
  const lines: string[] = [];
  if (p.action === 'new') {
    const src = p.sourceEntry;
    lines.push(
      `## 🔧 新约束提案 ${p.id} — 待审核`,
      '',
      `来源知识：${src ? `${src.title}（${src.id}）` : '（未知）'}——该条目已成熟且被反复引用，建议固化为项目约束。`,
      '',
      `约束 id：${p.constraintId}`,
      `条文草稿：${p.rule}`,
      `检查器：${p.checker ? CHECKER_LABELS[p.checker] : '待确认（无法从条目内容推断）'}`,
    );
    if (p.checker) {
      lines.push('参数草稿：');
      for (const [k, v] of Object.entries(p.params)) lines.push(`- ${k}: ${JSON.stringify(v)}`);
      lines.push('（参数为机器推断草稿，approve 即按卡面落定；不合适请 reject）');
    } else {
      lines.push('参数：待确认——参数不齐的条目无法落盘（会让 harness 加载报错），本卡只能 reject 或等人工补全后手工落盘');
    }
    lines.push(
      `严重度：${p.severity}`,
      `提示文案：${p.message}`,
      '',
      '批准后追加进目标仓 .harness/constraints.yml（不动既有条目）并自动 git commit 留痕；拒绝则零副作用，该条目不再重复提案。',
    );
  } else {
    // action='upgrade'（子项 8）：升级提案卡面
    lines.push(
      `## ⬆️ 约束升级提案 ${p.id} — 待审核`,
      '',
      `应用层约束：${p.constraintId}`,
      `条文：${p.rule}`,
      `检查器：${p.checker ? CHECKER_LABELS[p.checker] : '（内置 checker）'}`,
    );
    if (Object.keys(p.params).length > 0) {
      lines.push('当前参数：');
      for (const [k, v] of Object.entries(p.params)) lines.push(`- ${k}: ${JSON.stringify(v)}`);
    }
    if (p.statsText) lines.push(`使用情况：${p.statsText}`);
    lines.push(
      '',
      '批准后由 harness 打包脱敏提案材料（路径 + 摘要回帖本频道）；请人工确认材料无内部信息后，拿材料去 harness 仓开 issue（不自动开）。拒绝则零副作用。',
    );
  }
  return {
    content: lines.join('\n'),
    cardData: {
      proposalId: p.id,
      action: p.action,
      constraintId: p.constraintId,
      rule: p.rule,
      checker: p.checker,
      severity: p.severity,
      ...(p.sourceEntry ? { sourceEntry: p.sourceEntry } : {}),
    },
  };
}

/**
 * 注册 constraint adapter（kind='constraint'）。运行时装配 = EvolutionService 构造
 * （与 evolution adapter 同机注册）；audit-logs 聚合读面经 evolution 自助注册兜底带出。
 */
export function registerConstraintReviewAdapter(deps: {
  fileStore: FileStore;
  /** 缺省 <studio>/data/evolution（约束生命周期提案现归属 evolution 模块数据区） */
  dataDir?: string;
}): ReviewProposalAdapter<ConstraintProposal> {
  return registerReviewProposalAdapter<ConstraintProposal>({
    kind: 'constraint',
    cardType: 'constraint_proposal',
    storeNamespace: 'constraint-proposals',
    dataDir: deps.dataDir ?? studioPath('data', 'evolution'),
    fileStore: deps.fileStore,
    author: 'Evolution',
    renderCardContent: renderConstraintCard,
    onApprove: async (p): Promise<ApproveOutcome> => {
      if (p.action === 'new') {
        // 参数待确认的草稿不能落盘：aborted = 前置条件不可用，提案保持 pending（不落 failed 终态）
        const notReady = checkerParamsReady(p);
        if (notReady) return { status: 'aborted', error: notReady };
        try {
          const r = await applyNewConstraint(p);
          return { status: 'executed', data: { proposalId: p.id, constraintId: p.constraintId, ...r } };
        } catch (err) {
          return { status: 'failed', error: String(err instanceof Error ? err.message : err) };
        }
      }
      // action='upgrade'（子项 8）：spawn pack-proposal 打包脱敏材料 → 回帖 #系统
      try {
        const { materialPath } = await applyUpgradeProposal(p);
        await postUpgradeMaterialNote(deps.fileStore, p, materialPath);
        return { status: 'executed', data: { proposalId: p.id, constraintId: p.constraintId, materialPath } };
      } catch (err) {
        return { status: 'failed', error: String(err instanceof Error ? err.message : err) };
      }
    },
    // onReject 缺省：正本落 rejected 墓碑即够（提案记录即消耗标记，不再重复提案）
  });
}

/** 按 kind 取已注册 adapter（harness propose-upgrade 端点 / 测试用） */
export function getConstraintReviewAdapter(): ReviewProposalAdapter<ConstraintProposal> {
  const adapter = getReviewProposalAdapter<ConstraintProposal>('constraint');
  if (!adapter) throw new Error('constraint review adapter not registered（运行时装配缺失：EvolutionService 未构造）');
  return adapter;
}

export interface ConstraintScanResult {
  created: ConstraintProposal[];
  /** 跳过原因 → 计数（already-proposed / card-failed 不计跳过） */
  skipped: Record<string, number>;
  posted: number;
}

/**
 * 子项 7 runScan 链路：查知识库带 constraintCandidate 标签的条目 → 产新约束提案卡。
 * 消耗标记 = 提案记录：同一 entryId 已有任何状态（含 rejected）提案 → 跳过。
 * postCard=false 时只落提案不发卡（测试口径同 EvolutionService.postCard）。
 */
export async function scanConstraintCandidates(deps: {
  adapter: ReviewProposalAdapter<ConstraintProposal>;
  listEntries: () => KnowledgeEntry[];
  repoRoot: string;
  postCard: boolean;
}): Promise<ConstraintScanResult> {
  const { adapter } = deps;
  const candidates = deps.listEntries().filter(e => e.tags?.includes('constraintCandidate'));
  const skipped: Record<string, number> = {};
  if (candidates.length === 0) return { created: [], skipped, posted: 0 };

  const existing = await adapter.store.listProposals();
  const consumed = new Set(
    existing.filter(p => p.action === 'new' && p.sourceEntry).map(p => p.sourceEntry!.id),
  );

  const created: ConstraintProposal[] = [];
  let posted = 0;
  for (const entry of candidates.slice(0, MAX_NEW_CONSTRAINT_PROPOSALS_PER_RUN)) {
    if (consumed.has(entry.id)) {
      skipped['already-proposed'] = (skipped['already-proposed'] ?? 0) + 1;
      continue;
    }
    const rule = truncate(entry.content || entry.title, 200);
    const draft = inferCheckerDraft(entry.content ?? '');
    const proposal: ConstraintProposal = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      action: 'new',
      repoRoot: deps.repoRoot,
      constraintId: draftConstraintId(entry),
      rule,
      checker: draft.checker,
      params: draft.params,
      severity: 'warning',
      message: truncate(`违反约束：${rule}`, 80),
      sourceEntry: { id: entry.id, title: entry.title },
    };
    if (deps.postCard) {
      const r = await submitProposal(adapter, proposal);
      if (r.posted) posted++;
    } else {
      await adapter.store.appendProposal(proposal);
    }
    created.push(proposal);
    consumed.add(entry.id);
  }
  return { created, skipped, posted };
}
