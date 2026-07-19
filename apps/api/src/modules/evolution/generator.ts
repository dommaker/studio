/**
 * E1 约束进化：提案生成器（generator）。
 *
 * 信号 → 提案，三条链路（全范围，vision §6）：
 *   (a) iron-law/guideline：harness 约束 traces → TraceAnalyzer 异常检测 →
 *       autoEvolve（纯计算，autoApproveLowRisk=false —— 绝不自动生效）→
 *       映射为 EP 提案。仅映射可生效的变更种类：modify_message（改文案）、
 *       add_exception（内置约束追加例外）、new_constraint（新条目）；
 *       adjust_trigger/change_level 等结构性提案 v1 跳过（记入 skipped）。
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
  autoEvolve,
  TraceAnalyzer,
  TraceCollector,
  GUIDELINES,
  IRON_LAWS,
  TIPS,
} from '@dommaker/harness';
import {
  FileStore,
  formatEvolutionId,
  logger,
  type EvolutionProposalData,
  type EvolutionTargetType,
} from '@dommaker/studio-shared';
import { loadCustomConstraints } from './applier.js';
import { loadWindowSignals, type EvolutionPaths, type WindowSignals } from './signals.js';

/** autoEvolve 最少 trace 数 —— 低于此不做诊断（信号太薄） */
const MIN_TRACES = 5;
/** (b) 启发式阈值 */
const MIN_OUTCOME_FAILURES = 5;
const MIN_OUTCOME_FAIL_RATE = 0.5;
const MIN_INJECTED_FAILURES = 3;
/** (c) 启发式阈值 */
const MIN_ROLE_FAILURES = 5;
const MIN_ROLE_FAIL_RATE = 0.3;

export interface GenerationResult {
  created: EvolutionProposalData[];
  /** 跳过原因 → 计数（unsupported-type / custom-exception-unsupported / no-op / unknown-constraint / duplicate / open-exists） */
  skipped: Record<string, number>;
  scanned: { constraintTraces: number; toolCalls: number; outcomes: number };
}

interface RawProposal {
  targetType: EvolutionTargetType;
  targetId: string;
  action: 'add' | 'amend';
  constraintChange?: 'message' | 'exception' | 'new-entry';
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

/** (a) harness 约束 traces → autoEvolve → EP 提案映射 */
async function constraintProposals(
  signals: WindowSignals,
  deps: GeneratorDeps,
  skipped: Record<string, number>,
): Promise<RawProposal[]> {
  const traces = signals.constraintTraces;
  if (traces.length < MIN_TRACES) return [];

  const analyzer = new TraceAnalyzer(new TraceCollector({ traceFile: deps.paths.traceFile }));
  const summaries = analyzer.summarize(traces);
  const anomalies = analyzer.detectAnomalies(summaries);
  if (anomalies.length === 0) return [];

  // autoApproveLowRisk=false：所有提案都进入人工审核（needsReview），绝不自动执行
  const result = await autoEvolve(traces, anomalies, { autoApproveLowRisk: false });
  const custom = loadCustomConstraints(deps.paths.constraintsFile);
  const out: RawProposal[] = [];

  for (const p of result.proposals) {
    const id = p.constraintId;
    const customEntry = custom[id];
    const builtin = (IRON_LAWS as Record<string, { level?: string; message?: string }>)[id]
      ?? (GUIDELINES as Record<string, { level?: string; message?: string }>)[id]
      ?? (TIPS as Record<string, { level?: string; message?: string }>)[id]
      ?? null;
    if (!customEntry && !builtin) {
      skipped['unknown-constraint'] = (skipped['unknown-constraint'] ?? 0) + 1;
      continue;
    }
    const levelRaw = String(customEntry?.level ?? builtin?.level ?? 'guideline');
    const targetType: EvolutionTargetType = levelRaw === 'iron_law' ? 'iron-law' : 'guideline';
    const currentMessage = String(customEntry?.message ?? builtin?.message ?? '');
    const proposed = typeof p.content?.proposed === 'string'
      ? p.content.proposed
      : JSON.stringify(p.content?.proposed ?? '');
    const rationale = `${p.reasoning}（预期：${p.expectedOutcome}）`;
    const evidence: EvolutionProposalData['evidence'] = {
      windowHours: deps.windowHours,
      eventCounts: { constraintTraces: traces.length, anomalies: anomalies.length },
      samples: anomalies.filter(a => a.constraintId === id).map(a => a.message).slice(0, 3),
    };

    if (!proposed) {
      skipped['no-op'] = (skipped['no-op'] ?? 0) + 1;
      continue;
    }
    switch (p.type) {
      case 'modify_message':
        if (proposed === currentMessage) { skipped['no-op'] = (skipped['no-op'] ?? 0) + 1; continue; }
        out.push({
          targetType, targetId: id,
          action: customEntry ? 'amend' : 'add', // 内置约束 → 追加 shadow 条目覆盖
          constraintChange: 'message',
          currentText: currentMessage, proposedText: proposed, rationale,
          source: 'harness-autoEvolve', evidence,
        });
        break;
      case 'add_exception':
        if (customEntry) {
          // extend-only shadow 仅对内置约束有效（loader 语义）；自定义条目的例外追加 v1 不支持
          skipped['custom-exception-unsupported'] = (skipped['custom-exception-unsupported'] ?? 0) + 1;
          continue;
        }
        out.push({
          targetType, targetId: id, action: 'add', constraintChange: 'exception',
          currentText: currentMessage, proposedText: proposed, rationale,
          source: 'harness-autoEvolve', evidence,
        });
        break;
      case 'new_constraint':
        out.push({
          targetType, targetId: id, action: 'add', constraintChange: 'new-entry',
          currentText: '', proposedText: proposed, rationale,
          source: 'harness-autoEvolve', evidence,
        });
        break;
      default:
        // adjust_trigger / change_level：结构性变更，v1 不自动生效（需 schema 感知编辑）
        skipped['unsupported-type'] = (skipped['unsupported-type'] ?? 0) + 1;
    }
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
    ...(await constraintProposals(signals, deps, skipped).catch(err => {
      logger.warn('[Evolution] constraint proposal generation failed', { error: String(err) });
      return [] as RawProposal[];
    })),
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
