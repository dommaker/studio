/**
 * E1 约束进化：提案生成器（generator）。
 *
 * 信号 → 提案，三条链路（全范围，vision §6）：
 *   (a) iron-law/guideline：harness constraints usage report 的退役候选诊断
 *       （#602 D1，buildConstraintsUsageReport 公共导出，harness ≥1.10.1）——
 *       zero_trigger / unevaluable / high_noise / zero_intercept 四类候选映射为
 *       retire 提案（落点 = .harness/config.yml enabled:false，见 applier）。
 *       message/new-entry 类在 harness 1.10.0 无生效落点，不生成。
 *       每轮最多 3 个（保守，候选按 report 排序取前）。
 *   (b) prompt-template：轻量启发式 —— 窗口内任务失败率高（≥50% 且 ≥5 次）且
 *       多个失败任务已注入知识（≥3 个，R1 反馈环数据）→ 说明注入约束未被遵守，
 *       提议强化 knowledge.rules-section 区段文案。每轮最多 1 个。
 *   (c) role-preset：轻量启发式 —— tool:call traces 按 caller 分组，caller 命中
 *       `.agents/roles/<id>.yaml` 且失败 ≥5 次、失败率 ≥30% → 提议在该角色
 *       persona 末尾追加针对高频失败工具的警示。每轮每角色最多 1 个。
 *
 * 保守原则（默认 ON 但安静）：信号不足时零提案；与 pending/approved 提案同目标
 * 或与既有提案（stale 除外）同目标同文案的，跳过（去重防刷屏）。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  buildConstraintsUsageReport,
  CANDIDATE_KIND_LABEL,
  CONSTRAINTS,
  type ConstraintsUsageReport,
} from '@dommaker/harness';
import {
  FileStore,
  formatEvolutionId,
  logger,
  type EvolutionProposalData,
  type EvolutionTargetType,
} from '@dommaker/studio-shared';
import { loadWindowSignals, type EvolutionPaths, type WindowSignals } from './signals.js';

/** (b) 启发式阈值 */
const MIN_OUTCOME_FAILURES = 5;
const MIN_OUTCOME_FAIL_RATE = 0.5;
const MIN_INJECTED_FAILURES = 3;
/** (c) 启发式阈值 */
const MIN_ROLE_FAILURES = 5;
const MIN_ROLE_FAIL_RATE = 0.3;

export interface GenerationResult {
  created: EvolutionProposalData[];
  /** 跳过原因 → 计数（unsupported-type / no-op / unknown-constraint / duplicate / open-exists） */
  skipped: Record<string, number>;
  /** 本轮被 TTL 清扫转 stale 的提案 id（超期未审的 pending/approved，#602 D2） */
  staled: string[];
  scanned: { constraintTraces: number; toolCalls: number; outcomes: number };
}

/** 人审 TTL：pending/approved 超期未审自动转 stale，放行同目标新提案（#602 D2，EP-0002 自锁修复） */
export const EVOLUTION_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 提案是否超期未审（仅 pending/approved 参与判定；createdAt 不可解析视为未超期） */
export function isProposalExpired(p: EvolutionProposalData, now = Date.now()): boolean {
  if (p.status !== 'pending' && p.status !== 'approved') return false;
  const created = Date.parse(p.createdAt);
  return Number.isFinite(created) && now - created > EVOLUTION_PROPOSAL_TTL_MS;
}

interface RawProposal {
  targetType: EvolutionTargetType;
  targetId: string;
  action: 'add' | 'amend';
  constraintChange?: 'message' | 'exception' | 'new-entry' | 'retire';
  currentText: string;
  proposedText: string;
  rationale: string;
  source: string;
  evidence: EvolutionProposalData['evidence'];
}

export interface GeneratorDeps {
  fileStore: FileStore;
  paths: EvolutionPaths;
  windowHours: number;
}

/** (a) 启发式阈值：每轮最多产生的约束类提案数（保守原则） */
const MAX_CONSTRAINT_PROPOSALS_PER_RUN = 3;

/**
 * (a) harness 约束链路（#602 D1）—— 吃 constraints usage report 的退役候选。
 * 四类候选（zero_trigger / unevaluable / high_noise / zero_intercept）全部映射为
 * retire 提案：harness 1.10.0 起 config.yml `constraints.<id>.enabled:false` 是
 * 唯一真实生效落点，message/new-entry 类无消费端、不生成。
 * report 为全周期统计（非窗口）；读不到 traces → 零提案（保守安静）。
 */
async function constraintProposals(deps: GeneratorDeps): Promise<RawProposal[]> {
  let report: ConstraintsUsageReport;
  try {
    report = buildConstraintsUsageReport(deps.paths.repoRoot);
  } catch (err) {
    logger.warn('[Evolution] constraints usage report failed', { error: String(err) });
    return [];
  }
  if (!report.traceFileExists || report.candidates.length === 0) return [];

  const out: RawProposal[] = [];
  for (const c of report.candidates.slice(0, MAX_CONSTRAINT_PROPOSALS_PER_RUN)) {
    const builtin = (CONSTRAINTS as Record<string, { message?: string; description?: string } | undefined>)[c.id];
    if (!builtin) continue; // 非内置 id（config.yml 未知项）不由 E1 动
    out.push({
      targetType: c.stats.severity === 'error' ? 'iron-law' : 'guideline',
      targetId: c.id,
      action: 'amend',
      constraintChange: 'retire',
      currentText: builtin.message ?? builtin.description ?? c.id,
      proposedText: `退役（${CANDIDATE_KIND_LABEL[c.kind]}）：${c.reason}`,
      rationale: `harness constraints usage report 诊断候选（${CANDIDATE_KIND_LABEL[c.kind]}）：${c.reason}。` +
        `落点 = .harness/config.yml（enabled:false + retired 墓碑），恢复 = 删该段。`,
      source: 'harness:usage-report',
      evidence: {
        // report 是全周期统计（非窗口口径），windowHours 字段沿用本轮扫描窗口仅作记录
        windowHours: deps.windowHours,
        eventCounts: {
          total: c.stats.total,
          evaluated: c.stats.evaluated,
          fail: c.stats.fail,
          failRate: Math.round(c.stats.failRate * 1000) / 1000,
        },
        samples: [c.kind],
      },
    });
  }
  return out;
}

/** (b) prompt-template 启发式：注入了知识仍高失败 → 注入约束区段强调不足 */
function promptTemplateProposals(signals: WindowSignals, deps: GeneratorDeps): RawProposal[] {
  const total = signals.outcomes.length;
  if (total === 0) return [];
  const failures = signals.outcomes.filter(o => !o.success);
  const injectedFailures = failures.filter(o => o.consumedKnowledge.length > 0);
  if (failures.length < MIN_OUTCOME_FAILURES) return [];
  if (failures.length / total < MIN_OUTCOME_FAIL_RATE) return [];
  if (injectedFailures.length < MIN_INJECTED_FAILURES) return [];

  return [{
    targetType: 'prompt-template',
    targetId: 'knowledge.rules-section',
    action: 'amend',
    currentText: '## 系统约束\n{content}',
    proposedText: '## 系统约束\n以下约束必须逐条遵守——近期多个任务在注入约束后仍失败，违反约束是主要嫌疑：\n{content}',
    rationale: `窗口 ${deps.windowHours}h 内 ${failures.length}/${total} 个任务失败，其中 ${injectedFailures.length} 个已注入知识仍失败——注入约束未被有效遵守，建议强化「## 系统约束」区段文案。（{content} 为渲染期动态条目占位符）`,
    source: 'heuristic:prompt-failure',
    evidence: {
      windowHours: deps.windowHours,
      eventCounts: { outcomes: total, failures: failures.length, injectedFailures: injectedFailures.length },
    },
  }];
}

/** (c) role-preset 启发式：角色 caller 高频工具失败 → persona 追加警示 */
async function rolePresetProposals(signals: WindowSignals, deps: GeneratorDeps): Promise<RawProposal[]> {
  let roleIds: string[] = [];
  try {
    roleIds = fs.readdirSync(deps.paths.rolesDir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => f.replace(/\.yaml$/, ''));
  } catch {
    return [];
  }
  if (roleIds.length === 0) return [];

  const byCaller = new Map<string, { total: number; failures: string[] }>();
  for (const e of signals.toolCalls) {
    const caller = (e.caller ?? '').trim();
    if (!caller) continue;
    const bucket = byCaller.get(caller) ?? { total: 0, failures: [] };
    bucket.total++;
    if (e.success === false) bucket.failures.push(e.tool ?? 'unknown');
    byCaller.set(caller, bucket);
  }

  const out: RawProposal[] = [];
  for (const roleId of roleIds) {
    const bucket = byCaller.get(roleId);
    if (!bucket || bucket.failures.length < MIN_ROLE_FAILURES) continue;
    if (bucket.failures.length / bucket.total < MIN_ROLE_FAIL_RATE) continue;
    // 高频失败工具（众数）
    const counts = new Map<string, number>();
    for (const t of bucket.failures) counts.set(t, (counts.get(t) ?? 0) + 1);
    const topTool = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    let currentPersona = '';
    try {
      const parsed = yaml.load(fs.readFileSync(path.join(deps.paths.rolesDir, `${roleId}.yaml`), 'utf-8')) as { persona?: string } | null;
      currentPersona = typeof parsed?.persona === 'string' ? parsed.persona : '';
    } catch { /* 读不到则以空 persona 为底 */ }

    const guidance = `近期执行中 \`${topTool}\` 工具多次失败（${deps.windowHours}h 窗口内 ${bucket.failures.length} 次）。调用该工具前先验证参数与前置条件；连续失败两次后停止重试，改用替代方案或上报。`;
    out.push({
      targetType: 'role-preset',
      targetId: roleId,
      action: 'amend',
      currentText: currentPersona,
      proposedText: `${currentPersona.replace(/\s+$/, '')}\n${guidance}`,
      rationale: `角色 ${roleId} 窗口内工具失败 ${bucket.failures.length}/${bucket.total} 次（${Math.round((bucket.failures.length / bucket.total) * 100)}%），高频失败工具 ${topTool}——建议在 persona 追加针对性警示。`,
      source: 'heuristic:role-failure',
      evidence: {
        windowHours: deps.windowHours,
        eventCounts: { toolCalls: bucket.total, failures: bucket.failures.length },
        samples: [...new Set(bucket.failures)].slice(0, 5),
      },
    });
  }
  return out;
}

/**
 * 跑一轮提案生成：读信号 → 三条链路 → 去重 → 落盘（pending）。
 * 绝不生效任何提案 —— 生效只在人类 approve 后由 applier 执行。
 */
export async function generateEvolutionProposals(deps: GeneratorDeps): Promise<GenerationResult> {
  const { fileStore } = deps;
  const signals = await loadWindowSignals(deps.paths, deps.windowHours, fileStore);
  const skipped: Record<string, number> = {};

  const raw: RawProposal[] = [
    ...(await constraintProposals(deps).catch(err => {
      logger.warn('[Evolution] constraint proposal generation failed', { error: String(err) });
      return [] as RawProposal[];
    })),
    ...promptTemplateProposals(signals, deps),
    ...(await rolePresetProposals(signals, deps).catch(err => {
      logger.warn('[Evolution] role preset proposal generation failed', { error: String(err) });
      return [] as RawProposal[];
    })),
  ];

  // 去重：同目标已有 pending/approved（未闭环）→ 跳过；同目标同文案（历史任意状态，stale 除外）→ 跳过
  const existing = await fileStore.listEvolutionProposals();
  // TTL 清扫（#602 D2）：超期未审的 pending/approved 惰性转 stale —— 不开定时器，
  // 随每轮生成顺手做；stale 不再占 open 位，也未被人审过，允许同文案重提（不占 duplicate 位）。
  const staled: string[] = [];
  for (const p of existing) {
    if (!isProposalExpired(p)) continue;
    await fileStore.updateEvolutionProposal(p.id, { status: 'stale', staledAt: new Date().toISOString() });
    p.status = 'stale';
    staled.push(p.id);
  }
  const openTargets = new Set(
    existing.filter(p => p.status === 'pending' || p.status === 'approved').map(p => `${p.targetType}:${p.targetId}`),
  );
  const exactKeys = new Set(
    existing.filter(p => p.status !== 'stale').map(p => `${p.targetType}:${p.targetId}:${p.proposedText}`),
  );

  const created: EvolutionProposalData[] = [];
  for (const r of raw) {
    const targetKey = `${r.targetType}:${r.targetId}`;
    if (openTargets.has(targetKey)) { skipped['open-exists'] = (skipped['open-exists'] ?? 0) + 1; continue; }
    if (exactKeys.has(`${targetKey}:${r.proposedText}`)) { skipped['duplicate'] = (skipped['duplicate'] ?? 0) + 1; continue; }

    const seq = await fileStore.allocateEvolutionSeq();
    const proposal: EvolutionProposalData = {
      id: formatEvolutionId(seq),
      seq,
      targetType: r.targetType,
      targetId: r.targetId,
      action: r.action,
      ...(r.constraintChange ? { constraintChange: r.constraintChange } : {}),
      currentText: r.currentText,
      proposedText: r.proposedText,
      rationale: r.rationale,
      evidence: r.evidence,
      status: 'pending',
      source: r.source,
      createdAt: new Date().toISOString(),
    };
    await fileStore.createEvolutionProposal(proposal);
    created.push(proposal);
  }

  return {
    created,
    skipped,
    staled,
    scanned: {
      constraintTraces: signals.constraintTraces.length,
      toolCalls: signals.toolCalls.length,
      outcomes: signals.outcomes.length,
    },
  };
}
