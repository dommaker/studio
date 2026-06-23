/**
 * Scheduler Queue — 路由分类、资源管理、队列管理
 *
 * 从 goal-scheduler.ts 提取的纯函数。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { logger, extractUsage, parseStreamEvents } from '@dommaker/studio-shared';

// ─── Types ───

export interface ClassificationRecord {
  time: string; executionId: string; taskType: string;
  acCount: number; fileCount: number; classified: string; final: string;
  outcome?: 'success' | 'failure'; durationMs?: number; reviewScore?: number;
  taskCategory?: string;
}

export interface TierRoutingConfig {
  highRiskKeywords: RegExp;
  lowRiskKeywords: RegExp;
  premiumAcThreshold: number;
  premiumFileThreshold: number;
  fastAcThreshold: number;
  fastFileThreshold: number;
  explorationRate: number;
}

export const DEFAULT_TIER_ROUTING: TierRoutingConfig = {
  highRiskKeywords: /migration|migrate|auth|authentication|security|financial|payment|encrypt|crypto/,
  lowRiskKeywords: /style|typo|rename|format|lint|comment|doc|readme|spelling|refactor.*simple/,
  premiumAcThreshold: 6,
  premiumFileThreshold: 7,
  fastAcThreshold: 2,
  fastFileThreshold: 3,
  explorationRate: 0.1,
};

// ─── Routing / Classification ───

/**
 * 资源感知并发槽位
 * @param maxCap 可选上限，conservative 模式下传入 2 以限制并发
 */
export function getAvailableSlots(maxCap?: number): number {
  const freeMemPct = os.freemem() / os.totalmem();
  const load = os.loadavg()[0] / os.cpus().length;
  const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeMemGB = Math.round(os.freemem() / (1024 * 1024 * 1024));

  let slots: number;
  if (freeMemPct < 0.15) slots = 1;
  else if (freeMemPct < 0.30) slots = 2;
  else if (load > 0.90) slots = 2;
  else slots = 5; // MAX_CONCURRENT

  if (maxCap !== undefined) {
    slots = Math.min(slots, maxCap);
  }

  logger.info('[Scheduler] Resource check', {
    freeMemGB, totalMemGB, freeMemPct: Math.round(freeMemPct * 100) + '%',
    loadAvg: os.loadavg()[0].toFixed(2), cpuCores: os.cpus().length,
    slots, maxConcurrent: 5, ...(maxCap !== undefined ? { maxCap } : {}),
  });
  return slots;
}

/** 文件冲突检测 */
export function detectConflicts(executions: any[]): string[][] {
  const batches: string[][] = [];
  const remaining = new Set(executions.map((e: any) => e.id));

  while (remaining.size > 0) {
    const batch: string[] = [];
    const batchFiles = new Set<string>();

    for (const execId of [...remaining]) {
      const exec = executions.find((e: any) => e.id === execId);
      const input = parseJsonFieldLocal<Record<string, any> | null>(exec?.input, null);
      const files: string[] = input?.acGroup?.files || [];

      const hasConflict = files.some(f => batchFiles.has(f));
      if (!hasConflict) {
        batch.push(execId);
        files.forEach(f => batchFiles.add(f));
        remaining.delete(execId);
      }
    }

    if (batch.length === 0 && remaining.size > 0) {
      const first = [...remaining][0];
      batch.push(first);
      remaining.delete(first);
    }

    batches.push(batch);
  }

  return batches;
}

function parseJsonFieldLocal<T = any>(val: unknown, fallback?: T): T {
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T; } catch { return null as any; }
  }
  return (val as T) ?? (fallback as T);
}

/** G5 动态模型路由 */
export function classifyTaskComplexity(input: Record<string, any> | null, prompt: string, config: TierRoutingConfig = DEFAULT_TIER_ROUTING): string {
  const analystTier = input?.acGroup?.modelTier as string | undefined;
  if (analystTier && ['fast', 'standard', 'premium'].includes(analystTier)) {
    const reason = input?.acGroup?.modelTierReason || 'analyst-classified';
    logger.info('[Scheduler] Analyst modelTier adopted', { tier: analystTier, reason });
    return analystTier;
  }

  const acs = input?.acGroup?.acs ? JSON.stringify(input.acGroup.acs) : '';
  const taskDesc = (input?.taskDescription as string) || prompt || '';
  const combined = `${taskDesc} ${acs}`.toLowerCase();

  const isHighRiskDomain = config.highRiskKeywords.test(combined);
  const isLowRiskDomain = config.lowRiskKeywords.test(combined);
  const highRiskHits = combined.match(new RegExp(config.highRiskKeywords.source, 'gi')) || [];
  const lowRiskHits = combined.match(new RegExp(config.lowRiskKeywords.source, 'gi')) || [];

  const acCount = input?.acGroup?.acs?.length || 1;
  const files: string[] = input?.acGroup?.files || [];
  const fileCount = files.length;

  const notes = (input?.acGroup?.implementationNotes as string) || '';
  const notesLower = notes.toLowerCase();
  const trivialPattern = /^[（(]?\s*(import|添加\s*import|调用|add\s*call|insert|加一行|照抄)/;
  const complexPattern = /泛型|generic|状态机|state\s*machine|并发|concurrent|迁移|migrate|加密|encrypt|类型体操|type\s*transform/;
  const isLowSkill = trivialPattern.test(notesLower) || notesLower.length < 30;
  const isHighSkill = complexPattern.test(notesLower) && notesLower.length > 80;

  const gotchas = (input?.acGroup?.gotchas as string[]) || [];
  const estimatedLines = acCount * 15;
  const isSmallChange = estimatedLines <= 80 && fileCount <= 3 && gotchas.length <= 2;

  const premiumTrigger = isHighRiskDomain || acCount >= config.premiumAcThreshold || fileCount >= config.premiumFileThreshold;

  let tier: string;
  let reason: string;
  if (premiumTrigger) {
    tier = 'premium';
    const triggers = [];
    if (isHighRiskDomain) triggers.push(`keywords:${highRiskHits.join(',')}`);
    if (acCount >= config.premiumAcThreshold) triggers.push(`acCount=${acCount}`);
    if (fileCount >= config.premiumFileThreshold) triggers.push(`fileCount=${fileCount}`);
    reason = triggers.join('; ');
    if (!isHighRiskDomain && isLowSkill && acCount <= config.premiumAcThreshold && fileCount <= 5) {
      tier = 'standard';
      reason += ` (downgraded: lowSkill, notes="${notes.slice(0, 60)}")`;
    }
    if (!isHighRiskDomain && isSmallChange && tier === 'premium') {
      tier = 'standard';
      reason += ` (downgraded: smallChange, estLines~${estimatedLines}, files=${fileCount}, gotchas=${gotchas.length})`;
    }
  } else if (isLowRiskDomain && acCount <= config.fastAcThreshold && fileCount <= config.fastFileThreshold) {
    tier = 'fast';
    reason = `lowRisk keywords:${lowRiskHits.join(',')}, acCount=${acCount}, fileCount=${fileCount}`;
  } else {
    tier = 'standard';
    reason = `default (acCount=${acCount}, fileCount=${fileCount}, highRisk=${isHighRiskDomain}, lowRisk=${isLowRiskDomain})`;
    if (isHighSkill) {
      tier = 'premium';
      reason += ` (upgraded: highSkill, notes="${notes.slice(0, 60)}")`;
    }
  }

  logger.info('[Scheduler] Complexity classified', { tier, reason, acCount, fileCount });
  return tier;
}

/** Phase 3: 推断任务类型 */
export function inferTaskCategory(prompt: string, input: Record<string, any> | null): string {
  const combined = `${prompt} ${JSON.stringify(input?.acGroup?.acs || [])}`.toLowerCase();
  if (/test|测试|vitest|jest|spy|mock/i.test(combined)) return 'test';
  if (/import|修复.*import|添加.*import|fix.*import/i.test(combined)) return 'import-fix';
  if (/discord|route|endpoint|api.*route|channel/i.test(combined)) return 'integration';
  if (/schema|migration|prisma|migrate/i.test(combined)) return 'schema';
  if (/auth|token|jwt|oauth|password|security/i.test(combined)) return 'auth';
  if (/config|setup|init|start|docker|deploy/i.test(combined)) return 'config';
  if (/refactor|重构/i.test(combined)) return 'refactor';
  return 'general';
}

/** 从历史数据中找到该 category 成功率最高的 tier */
export function getHistoricalBestTier(taskCategory: string, classifications: ClassificationRecord[]): string | null {
  const stats: Record<string, { total: number; success: number }> = {};
  for (const c of classifications) {
    if (c.taskCategory !== taskCategory || !c.outcome) continue;
    const key = c.final;
    if (!stats[key]) stats[key] = { total: 0, success: 0 };
    stats[key].total++;
    if (c.outcome === 'success') stats[key].success++;
  }

  const MIN_SAMPLES = 5;
  let bestTier: string | null = null;
  let bestRate = 0;
  for (const [tier, s] of Object.entries(stats)) {
    if (s.total < MIN_SAMPLES) continue;
    const rate = s.success / s.total;
    if (rate > bestRate) {
      bestRate = rate;
      bestTier = tier;
    }
  }

  if (bestTier) {
    logger.info('[Scheduler] Historical routing feedback', {
      taskCategory, bestTier, bestRate: bestRate.toFixed(2),
      samples: Object.fromEntries(Object.entries(stats).map(([t, s]) => [t, `${s.success}/${s.total}`])),
    });
  }
  return bestTier;
}

/** Phase 1: 持久化路由统计到文件 */
export function persistRoutingStats(classifications: ClassificationRecord[]): void {
  try {
    const file = path.join(process.env.STUDIO_CONFIG_DIR || path.join(os.homedir(), '.studio'), '.harness', 'routing.jsonl');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const last = classifications[classifications.length - 1];
    fs.appendFileSync(file, JSON.stringify(last) + '\n', 'utf-8');
  } catch {}
}

/** Phase 1: 启动时恢复路由统计 */
export function restoreRoutingStats(): ClassificationRecord[] {
  const result: ClassificationRecord[] = [];
  try {
    const file = path.join(process.env.STUDIO_CONFIG_DIR || path.join(os.homedir(), '.studio'), '.harness', 'routing.jsonl');
    if (!fs.existsSync(file)) return result;
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').slice(-200);
    for (const line of lines) {
      try { result.push(JSON.parse(line)); } catch {}
    }
    logger.info('[Scheduler] Restored routing stats', { count: result.length });
  } catch {}
  return result;
}

/** Phase 2: ε-greedy — premium 任务以 ε 概率降级到 standard 试探边界 */
export function maybeExploreDowngrade(tier: string, taskCategory: string, explorationRate: number): { tier: string; exploring: boolean } {
  if (tier !== 'premium') return { tier, exploring: false };
  if (taskCategory === 'auth' || taskCategory === 'schema') return { tier, exploring: false };
  if (Math.random() > explorationRate) return { tier, exploring: false };

  logger.info('[Scheduler] ε-greedy: exploring standard for premium task', { taskCategory });
  return { tier: 'standard', exploring: true };
}

/** G5 进化: 分析路由决策 → 双向反馈 */
export function analyzeRoutingFeedback(classifications: ClassificationRecord[], explorationCount: number, explorationSuccess: number): Array<{ type: string; message: string; evidence: string }> {
  const suggestions: Array<{ type: string; message: string; evidence: string }> = [];
  const completed = classifications.filter(c => c.outcome);
  if (completed.length < 5) return suggestions;

  const byTier = new Map<string, { total: number; success: number; reviewScores: number[] }>();
  for (const c of completed) {
    const key = `${c.classified}|${c.taskCategory || 'any'}`;
    if (!byTier.has(key)) byTier.set(key, { total: 0, success: 0, reviewScores: [] });
    const entry = byTier.get(key)!;
    entry.total++;
    if (c.outcome === 'success') { entry.success++; }
    if (c.reviewScore) { entry.reviewScores.push(c.reviewScore); }
  }

  for (const [key, stats] of byTier) {
    const [tier, category] = key.split('|');
    if (stats.total < 3) continue;

    const successRate = stats.success / stats.total;
    const avgReview = stats.reviewScores.length > 0
      ? stats.reviewScores.reduce((a, b) => a + b, 0) / stats.reviewScores.length
      : null;

    if (tier !== 'premium' && successRate < 0.5) {
      suggestions.push({
        type: 'routing.upgrade',
        message: `${tier}/"${category}" failure rate ${Math.round((1 - successRate) * 100)}% → try premium`,
        evidence: `${stats.total} tasks, ${stats.success} success, avg review ${avgReview ?? 'N/A'}`,
      });
    }

    if (tier === 'premium' && successRate >= 1.0 && avgReview && avgReview >= 80) {
      suggestions.push({
        type: 'routing.downgrade',
        message: `premium/"${category}" 100% success (${stats.total} tasks, avg review ${Math.round(avgReview)}) → try standard`,
        evidence: `ε-greedy: next premium/"${category}" task has 10% chance to use standard`,
      });
    }
  }

  if (explorationCount > 0) {
    const exploreRate = explorationSuccess / explorationCount;
    suggestions.push({
      type: 'routing.exploration',
      message: `ε-greedy: ${explorationSuccess}/${explorationCount} explorations succeeded (${Math.round(exploreRate * 100)}%)`,
      evidence: exploreRate > 0.8 ? 'boundary expanding' : 'boundary stable',
    });
  }

  return suggestions;
}

/** INF-004: strategy switching */
export function getDispatchStrategy(recentFailures: number, recentTotal: number): 'normal' | 'conservative' {
  if (recentTotal < 5) return 'normal';
  const failRate = recentFailures / recentTotal;
  return failRate > 0.5 ? 'conservative' : 'normal';
}

/** 更新 dispatch 结果计数 */
export function updateDispatchOutcome(state: { failures: number; total: number }, success: boolean): { failures: number; total: number } {
  let { failures, total } = state;
  failures += success ? 0 : 1;
  total++;
  if (total > 20) { total = 20; failures = Math.min(failures, 20); }
  return { failures, total };
}

/** Q5: 从 agent log JSON 提取 token 和模型数据 */
export function parseAgentTokenUsage(worktreeDir: string): {
  model: string; inputTokens: number; outputTokens: number; cacheHitTokens: number;
} {
  try {
    const logFile = path.join(worktreeDir, '.agent.log');
    if (!fs.existsSync(logFile)) return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };

    const content = fs.readFileSync(logFile, 'utf-8').trim();
    if (!content) return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };

    const lines = content.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);
    const mu = parsed.modelUsage || {};
    const modelKeys = Object.keys(mu);
    const model = modelKeys.length > 0 ? modelKeys[0] : 'unknown';

    // Sum across all models — multi-model sessions (e.g. primary + fallback)
    // have separate entries in modelUsage, each with their own token counts.
    let inputTokens = 0, outputTokens = 0, cacheHitTokens = 0;
    for (const k of modelKeys) {
      const d = mu[k] || {};
      inputTokens += d.inputTokens || 0;
      outputTokens += d.outputTokens || 0;
      cacheHitTokens += d.cacheReadInputTokens || 0;
    }

    // Fallback: stream-json format has no modelUsage — extract from usage fields
    if (model === 'unknown' && inputTokens === 0) {
      const events = parseStreamEvents(content);
      const usage = extractUsage(events);
      if (usage.inputTokens > 0) {
        return { model: usage.model || 'unknown', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheHitTokens: usage.cacheReadTokens };
      }
    }

    return { model, inputTokens, outputTokens, cacheHitTokens };
  } catch {
    return { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
  }
}
