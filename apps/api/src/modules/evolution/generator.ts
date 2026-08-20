/**
 * E1 约束进化：提案生成器（generator）。
 *
 * 信号 → 提案，三条链路（全范围，vision §6）：
 *   (a) iron-law/guideline：【暂时挂起 —— harness 0.17.0】autoEvolve 已删除
 *       （ADR-0001 决策 8）。替代数据源 buildConstraintsUsageReport /
 *       diagnoseRetireCandidates 存在于 dist/core/constraints/usage-report，
 *       但未从包公开导出（exports map 的 ./core 也不含）。等待改吃
 *       constraints report 候选数据（飞轮修复立项 ①，
 *       docs/plans/2026-08-flywheel-repair-e1.md），当前恒返回空提案。
 *   (b) prompt-template：轻量启发式 —— 窗口内任务失败率高（≥50% 且 ≥5 次）且
 *       多个失败任务已注入知识（≥3 个，R1 反馈环数据）→ 说明注入约束未被遵守，
 *       提议强化 knowledge.rules-section 区段文案。每轮最多 1 个。
 *   (c) role-preset：轻量启发式 —— tool:call traces 按 caller 分组，caller 命中
 *       `.agents/roles/<id>.yaml` 且失败 ≥5 次、失败率 ≥30% → 提议在该角色
 *       persona 末尾追加针对高频失败工具的警示。每轮每角色最多 1 个。
 *
 * 保守原则（默认 ON 但安静）：信号不足时零提案；与 pending/approved 提案同目标
 * 或与既有提案同目标同文案的，跳过（去重防刷屏）。
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
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
  scanned: { constraintTraces: number; toolCalls: number; outcomes: number };
}

interface RawProposal {
  targetType: EvolutionTargetType;
  targetId: string;
  action: 'add' | 'amend';
  constraintChange?: 'message' | 'new-entry';
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

/**
 * (a) harness 约束链路 —— 暂时挂起（harness 0.17.0，ADR-0001 决策 8）。
 * autoEvolve 已删除；report 数据层（buildConstraintsUsageReport /
 * diagnoseRetireCandidates）在 dist/core/constraints/usage-report 存在但未公开导出，
 * 等待改吃 constraints report 候选数据（飞轮修复立项 ①）。
 * 复活时恢复 traces → 退役候选 → modify_message/new_constraint 映射。
 */
async function constraintProposals(): Promise<RawProposal[]> {
  return [];
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
    ...(await constraintProposals()),
    ...promptTemplateProposals(signals, deps),
    ...(await rolePresetProposals(signals, deps).catch(err => {
      logger.warn('[Evolution] role preset proposal generation failed', { error: String(err) });
      return [] as RawProposal[];
    })),
  ];

  // 去重：同目标已有 pending/approved（未闭环）→ 跳过；同目标同文案（历史任意状态）→ 跳过
  const existing = await fileStore.listEvolutionProposals();
  const openTargets = new Set(
    existing.filter(p => p.status === 'pending' || p.status === 'approved').map(p => `${p.targetType}:${p.targetId}`),
  );
  const exactKeys = new Set(existing.map(p => `${p.targetType}:${p.targetId}:${p.proposedText}`));

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
    scanned: {
      constraintTraces: signals.constraintTraces.length,
      toolCalls: signals.toolCalls.length,
      outcomes: signals.outcomes.length,
    },
  };
}
