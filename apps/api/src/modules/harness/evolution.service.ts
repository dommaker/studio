/**
 * Constraint Evolution Service — 约束规则进化
 *
 * 接入 harness autoEvolve 管线：
 *  trace 收集 → 定期触发 → 诊断 → 提案 → 人工审核 → 生命周期执行
 *
 * P0: 从静态规则到自学习约束
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';

interface EvolutionState {
  failureCount: number;
  lastEvolveAt: string | null;
  pendingProposals: number;
}

/** In-memory pattern failure buffer: errorPattern → Set<workUnitId> */
const patternFailures = new Map<string, Set<string>>();

/** Extract error pattern from message using simple keyword classification */
function classifyErrorPattern(errorMsg: string): string {
  const msg = errorMsg.toLowerCase();
  if (msg.includes('review') && (msg.includes('exhausted') || msg.includes('cycle'))) return 'review_cycle_exhausted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('test') && msg.includes('fail')) return 'test_failure';
  if (msg.includes('type') || msg.includes('lint') || msg.includes('tsc')) return 'type_error';
  if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) return 'database_error';
  if (msg.includes('git') || msg.includes('worktree')) return 'git_error';
  if (msg.includes('port') || msg.includes('eaddrinuse')) return 'port_conflict';
  if (msg.includes('model') || msg.includes('token') || msg.includes('llm')) return 'llm_error';
  if (msg.includes('docker') || msg.includes('container')) return 'docker_error';
  if (msg.includes('permission') || msg.includes('denied')) return 'permission';
  return 'other';
}

const STATE_FILE = '.harness/evolution-state.json';

function loadState(): EvolutionState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { failureCount: 0, lastEvolveAt: null, pendingProposals: 0 };
  }
}

function saveState(state: EvolutionState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** 记录一次失败（供 agent-event-listener 调用） */
export function recordFailure(workUnitId?: string, errorMsg?: string): void {
  const state = loadState();
  state.failureCount++;
  saveState(state);

  // Pattern buffer: track recurring error patterns across different workUnits
  if (workUnitId && errorMsg) {
    const pattern = classifyErrorPattern(errorMsg);
    const goals = patternFailures.get(pattern) || new Set<string>();
    goals.add(workUnitId);
    patternFailures.set(pattern, goals);

    // Same pattern across 3+ different workUnits → trigger evolution immediately
    if (goals.size >= 3) {
      logger.warn('[Evolution] Pattern detected across 3+ workUnits, triggering evolution', {
        pattern,
        affectedWorkUnits: [...goals],
      });
      runEvolution().then(result => {
        if (result) logger.info('[Evolution] Triggered by cross-workUnit pattern', { pattern, ...result });
      }).catch(e => logger.warn('[Evolution] Pattern-triggered evolution failed', { error: String(e) }));
    }
  }
}

/** 记录一次成功（降低失败计数，避免误触发进化） */
export function recordSuccess(): void {
  const state = loadState();
  state.failureCount = Math.max(0, state.failureCount - 1);
  saveState(state);
}

/** 记录审查被拒绝（供 agent-event-listener 调用，Phase 3） */
export function recordReviewRejected(workUnitId: string, taskId: string, cycle: number): void {
  const state = loadState();
  state.failureCount++;
  saveState(state);

  // Add to pattern buffer
  const pattern = 'review_cycle_exhausted';
  const goals = patternFailures.get(pattern) || new Set<string>();
  goals.add(workUnitId);
  patternFailures.set(pattern, goals);

  logger.info('[Evolution] Review rejected recorded', { workUnitId, taskId, cycle, totalFailures: state.failureCount });

  // Same pattern across 3+ different workUnits → trigger evolution immediately
  if (goals.size >= 3) {
    logger.warn('[Evolution] Review rejection pattern across 3+ workUnits, triggering evolution', {
      pattern,
      affectedWorkUnits: [...goals],
    });
    runEvolution().then(result => {
      if (result) logger.info('[Evolution] Triggered by review rejection pattern', { pattern, ...result });
    }).catch(e => logger.warn('[Evolution] Review-triggered evolution failed', { error: String(e) }));
  }
}

/** Get snapshot of pattern failure buffer (for auditing, Phase 3) */
export function getPatternBufferSnapshot(): Array<{ pattern: string; affectedWorkUnits: string[]; count: number }> {
  return [...patternFailures.entries()].map(([pattern, goals]) => ({
    pattern,
    affectedWorkUnits: [...goals],
    count: goals.size,
  }));
}

/** 检查是否应该触发进化（阈值：累计 5+ 失败 或 距上次进化 24h+） */
export function shouldEvolve(): boolean {
  const state = loadState();
  if (state.failureCount >= 5) return true;
  if (state.lastEvolveAt) {
    const hoursSince = (Date.now() - new Date(state.lastEvolveAt).getTime()) / 3600000;
    if (hoursSince >= 24 && state.failureCount >= 2) return true;
  }
  return false;
}

/** 触发约束进化 */
export async function runEvolution(): Promise<{
  diagnoses: number;
  proposals: number;
  autoApproved: number;
  needsReview: number;
} | null> {
  const state = loadState();
  if (!shouldEvolve()) return null;

  try {
    // 读取 harness trace 日志
    const traceDir = path.join(process.cwd(), '.harness', 'logs');
    const traces: any[] = [];
    const anomalies: any[] = [];

    if (fs.existsSync(traceDir)) {
      const files = fs.readdirSync(traceDir).filter(f => f.startsWith('traces') && f.endsWith('.log'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(traceDir, file), 'utf-8');
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'trace') traces.push(entry);
            if (entry.type === 'anomaly') anomalies.push(entry);
          } catch (e) {
            logger.warn('[HarnessEvolution] Skipping malformed trace line', { error: String(e) });
          }
        }
      }
    }

    if (traces.length === 0) {
      // 无 trace 数据，直接标记已进化（重置失败计数）
      state.failureCount = 0;
      state.lastEvolveAt = new Date().toISOString();
      saveState(state);
      return null;
    }

    // 运行 autoEvolve
    const harness = await import('@dommaker/harness');
    const result = await harness.autoEvolve(traces, anomalies, { autoApproveLowRisk: true });

    // 保存 proposals（非自动审批的）到文件供审核
    if (result.proposals.length > 0) {
      const proposalsDir = path.join(process.cwd(), '.harness', 'proposals');
      if (!fs.existsSync(proposalsDir)) fs.mkdirSync(proposalsDir, { recursive: true });

      for (const p of result.proposals) {
        const file = path.join(proposalsDir, `${p.id}.json`);
        fs.writeFileSync(file, JSON.stringify(p, null, 2));
      }
    }

    // 执行已自动审批的提案
    if (result.executions.length > 0) {
      logger.info('[Evolution] Executed proposals', { count: result.executions.length });
    }

    state.failureCount = 0;
    state.lastEvolveAt = new Date().toISOString();
    state.pendingProposals = result.needsReview;
    saveState(state);

    logger.info('[Evolution] Completed', {
      diagnoses: result.diagnoses.length,
      proposals: result.proposals.length,
      autoApproved: result.autoApproved,
      needsReview: result.needsReview,
    });

    return {
      diagnoses: result.diagnoses.length,
      proposals: result.proposals.length,
      autoApproved: result.autoApproved,
      needsReview: result.needsReview,
    };
  } catch (error) {
    logger.error('[Evolution] Failed', { error: String(error) });
    return null;
  }
}
