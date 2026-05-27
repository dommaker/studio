/**
 * KnowledgeSync — 自运转知识同步系统
 *
 * 抽象：代码变了 → 知识自动跟上。不等人指出断点，自己检测、自己修复。
 *
 * 三个循环：
 *   1. Capture:  分析完成 → 自动 upsert 知识
 *   2. Detect:   git 变更 vs 知识 scope → 检测过期
 *   3. Heal:     过期知识 → 标记 freshness、触发重分析
 */

import { execSync } from 'child_process';
import { logger } from '@dommaker/studio-shared';
import { sharedStore, sharedLifecycle, upsertKnowledge, knowledgeBus } from './knowledge-bus.service.js';
import type { KnowledgeSource } from './knowledge-bus.service.js';

// ── Scope Registry ──
// scope → associated source files (glob patterns). When any of these files change, the scope is stale.

interface ScopeConfig {
  files: string[];          // glob patterns for source files
  title: string;            // human-readable title
  knowledgeType: 'architecture' | 'process' | 'guideline';
}

const DEFAULT_SCOPE_REGISTRY: Record<string, ScopeConfig> = {
  'pipeline-stages': {
    files: ['apps/api/src/modules/goals/goal-scheduler.ts', 'apps/api/src/modules/goals/goal.service.ts', 'apps/api/src/modules/channels/analyst-trigger.service.ts', 'apps/api/src/modules/channels/channel.routes.ts'],
    title: 'Pipeline Stages',
    knowledgeType: 'process',
  },
  'pipeline-agents': {
    files: ['apps/api/src/modules/agents/*.ts', 'packages/studio-agent/src/services/agent-executor.ts'],
    title: 'Pipeline Agents',
    knowledgeType: 'architecture',
  },
  'pipeline-logging': {
    files: ['apps/api/src/modules/agents/*.service.ts', 'apps/api/src/daemon/metrics.ts', 'packages/studio-shared/src/llm/model-gateway.ts'],
    title: 'Pipeline Logging & Observability',
    knowledgeType: 'architecture',
  },
  'knowledge-circuit': {
    files: ['apps/api/src/modules/knowledge/knowledge-bus.service.ts', 'apps/api/src/modules/knowledge/knowledge-sync.service.ts', 'apps/api/src/modules/agents/monitor-agent.service.ts', 'harness/src/knowledge/lifecycle.ts', 'harness/src/knowledge/ingest.ts'],
    title: 'Knowledge Circuit Self-Check',
    knowledgeType: 'architecture',
  },
  'knowledge-sync': {
    files: ['apps/api/src/modules/knowledge/knowledge-sync.service.ts', 'apps/api/src/modules/knowledge/routes.ts', 'apps/api/src/modules/channels/analyst-trigger.service.ts', 'apps/api/src/modules/agents/monitor-agent.service.ts'],
    title: 'KnowledgeSync Service',
    knowledgeType: 'architecture',
  },
  'plan-coverage': {
    files: ['apps/api/src/modules/agents/post-eval-agent.service.ts', 'harness/src/cli/commands/posteval-plan.ts', 'harness/bin/harness.js', '.git/hooks/pre-commit'],
    title: 'Plan Coverage via PostEval',
    knowledgeType: 'architecture',
  },
  'knowledge-types': {
    files: ['apps/api/src/modules/knowledge/knowledge-bus.service.ts', 'apps/api/src/modules/knowledge/knowledge-sync.service.ts'],
    title: 'Knowledge Types: Pattern vs Document',
    knowledgeType: 'architecture',
  },
  'knowledgestore-bp': {
    files: ['apps/api/src/modules/knowledge/knowledge-bus.service.ts', 'apps/api/src/modules/knowledge/knowledge-sync.service.ts', 'apps/api/src/modules/agents/monitor-agent.service.ts', 'harness/src/knowledge/ingest.ts', 'harness/src/knowledge/lifecycle.ts'],
    title: 'KnowledgeStore Breakpoint Fixes',
    knowledgeType: 'architecture',
  },
  'pipeline-state-machines': {
    files: ['apps/api/src/modules/goals/goal-scheduler.ts', 'apps/api/src/modules/goals/goal.service.ts'],
    title: 'Pipeline State Machines & Model Tiers',
    knowledgeType: 'architecture',
  },
};

// ── Types ──

export interface StaleReport {
  scope: string;
  title: string;
  knowledgeEntryId: string;
  lastUpdated: string;
  changedFiles: string[];
  stalenessHours: number;
}

export interface UnmonitoredReport {
  scope: string;
  title: string;
  knowledgeEntryId: string;
  reason: 'no-scope-config' | 'no-files-tracked';
}

export interface SyncResult {
  scope: string;
  action: 'created' | 'updated' | 'refreshed' | 'unchanged' | 'stale';
  entryId: string;
  details?: string;
}

// ── Service ──

class KnowledgeSyncService {
  private registry: Record<string, ScopeConfig>;

  constructor(registry?: Record<string, ScopeConfig>) {
    this.registry = registry || DEFAULT_SCOPE_REGISTRY;
  }

  /**
   * 注册一个新 scope（Agent 分析完某个子系统后调用，声明"我跟踪这些文件"）
   */
  registerScope(scope: string, config: ScopeConfig): void {
    this.registry[scope] = config;
    logger.info('[KnowledgeSync] Scope registered', { scope, fileCount: config.files.length });
  }

  getTrackedScopes(): string[] {
    return Object.keys(this.registry);
  }

  getScopeConfig(scope: string): ScopeConfig | undefined {
    return this.registry[scope];
  }

  /**
   * Cycle 1 — Capture:
   * Agent 分析完成后调用。按 scope 去重写入，记录关联文件供后续新鲜度检测。
   */
  async capture(params: {
    scope: string;
    content: string;
    source?: KnowledgeSource;
  }): Promise<SyncResult> {
    const startTime = Date.now();
    const { scope, content, source = 'analyst' } = params;
    const config = this.registry[scope];

    // Auto-register if unknown scope
    if (!config) {
      this.registry[scope] = {
        files: [],
        title: scope,
        knowledgeType: 'architecture',
      };
      logger.info('[KnowledgeSync] Auto-registered unknown scope', { scope });
    }

    const result = await upsertKnowledge({
      scope,
      title: config?.title || scope,
      content,
      type: config?.knowledgeType || 'architecture',
      source,
    });

    const durationMs = Date.now() - startTime;
    logger.info('[KnowledgeSync] Captured', {
      scope, action: result.action, entryId: result.entryId,
      contentSize: content.length, durationMs,
    });

    // Write capture event to knowledge store (meta-knowledge)
    knowledgeBus.recordPattern({
      source: 'analyst',
      type: 'trend',
      title: `KnowledgeSync capture: ${scope} (${result.action})`,
      content: `Scope: ${scope}\nAction: ${result.action}\nEntry: ${result.entryId}\nContent size: ${content.length}B\nDuration: ${durationMs}ms`,
      severity: 'info',
      timestamp: Date.now(),
    }).catch(() => {});

    return { scope, ...result };
  }

  /**
   * Cycle 2 — Detect:
   * 对比每个 tracked scope 的关联文件 git log 和知识的 lastReferenced。
   * 如果关联文件在知识最后一次更新后有新 commit → stale。
   */
  detectStaleness(repoDir?: string): { stale: StaleReport[]; unmonitored: UnmonitoredReport[] } {
    const startTime = Date.now();
    const baseDir = repoDir || process.env.REPO_DIR || process.cwd();
    const stale: StaleReport[] = [];
    const unmonitored: UnmonitoredReport[] = [];
    let scopesChecked = 0;
    let filesChecked = 0;
    let gitErrors = 0;

    try {
      // ── Registered scopes: full staleness check ──
      for (const [scope, config] of Object.entries(this.registry)) {
        if (config.files.length === 0) continue;
        scopesChecked++;

        const entries = sharedStore.list({ tags: ['design-doc'] })
          .filter(e => e.tags?.includes(scope));
        const latest = entries.sort((a, b) => b.lastReferenced.localeCompare(a.lastReferenced))[0];
        if (!latest) continue;

        const lastUpdated = new Date(latest.lastReferenced || latest.created);
        const stalenessHours = Math.round((Date.now() - lastUpdated.getTime()) / (60 * 60 * 1000));
        if (stalenessHours < 1) continue;

        const changedFiles: string[] = [];
        for (const filePattern of config.files) {
          filesChecked++;
          try {
            const since = lastUpdated.toISOString().slice(0, 19).replace('T', ' ');
            const result = execSync(
              `git log --since="${since}" --oneline -- "${filePattern}" 2>/dev/null | head -1`,
              { cwd: baseDir, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 },
            ).trim();
            if (result) changedFiles.push(filePattern);
          } catch { gitErrors++; }
        }

        if (changedFiles.length > 0) {
          stale.push({
            scope, title: config.title, knowledgeEntryId: latest.id,
            lastUpdated: lastUpdated.toISOString(), changedFiles, stalenessHours,
          });
        }
      }

      // ── Unregistered design-docs: detect blind spots ──
      const allDesignDocs = sharedStore.list({ tags: ['design-doc'] });
      const registeredScopes = new Set(Object.keys(this.registry));
      for (const entry of allDesignDocs) {
        const entryScope = entry.tags?.find(t => t !== 'design-doc');
        if (!entryScope) {
          unmonitored.push({
            scope: entry.id.slice(0, 16),
            title: entry.title,
            knowledgeEntryId: entry.id,
            reason: 'no-scope-config',
          });
          continue;
        }
        if (!registeredScopes.has(entryScope)) {
          const config = this.registry[entryScope];
          unmonitored.push({
            scope: entryScope,
            title: entry.title,
            knowledgeEntryId: entry.id,
            reason: config && config.files.length === 0 ? 'no-files-tracked' : 'no-scope-config',
          });
        }
      }
    } catch (e: any) {
      logger.warn('[KnowledgeSync] detectStaleness failed', { error: String(e) });
    }

    logger.info('[KnowledgeSync] Staleness detection complete', {
      durationMs: Date.now() - startTime,
      scopesChecked,
      filesChecked,
      gitErrors,
      staleCount: stale.length,
      unmonitoredCount: unmonitored.length,
    });

    return { stale, unmonitored };
  }

  /**
   * Cycle 3 — Heal:
   * 对过期条目：刷新 lastReferenced 防止衰减，标记为需要重分析。
   * 真正的"修复"是触发一次重分析（Analyst agent re-explore scope），
   * 但这里至少保证过期知识不会悄悄腐烂。
   */
  async heal(staleReports: StaleReport[]): Promise<string[]> {
    const startTime = Date.now();
    const healed: string[] = [];
    let failures = 0;

    for (const report of staleReports) {
      try {
        sharedLifecycle.recordReference(report.knowledgeEntryId, 'knowledge-sync');
        sharedStore.update(report.knowledgeEntryId, { maturity: 'draft' });
        healed.push(report.scope);
        logger.warn('[KnowledgeSync] Marked stale — needs re-analysis', {
          scope: report.scope,
          changedFiles: report.changedFiles,
          stalenessHours: report.stalenessHours,
        });
      } catch (e: any) {
        failures++;
        logger.warn('[KnowledgeSync] Heal failed', { scope: report.scope, error: String(e) });
      }
    }

    logger.info('[KnowledgeSync] Heal complete', {
      durationMs: Date.now() - startTime,
      healedCount: healed.length,
      failures,
    });

    return healed;
  }

  /**
   * Full sync cycle: detect + heal. Called by MonitorAgent hourly.
   */
  async runSyncCycle(repoDir?: string): Promise<{ stale: StaleReport[]; unmonitored: UnmonitoredReport[]; healed: string[] }> {
    const startTime = Date.now();

    const { stale, unmonitored } = this.detectStaleness(repoDir);

    // Auto-register unmonitored scopes so they get tracked next cycle
    for (const u of unmonitored) {
      if (!this.registry[u.scope]) {
        this.registry[u.scope] = {
          files: [],
          title: u.title,
          knowledgeType: 'architecture',
        };
        logger.info('[KnowledgeSync] Auto-registered unmonitored scope', { scope: u.scope, title: u.title });
      }
    }

    let healed: string[] = [];
    if (stale.length > 0) {
      healed = await this.heal(stale);
    }

    const durationMs = Date.now() - startTime;

    // Write sync cycle event to knowledge store
    knowledgeBus.recordPattern({
      source: 'monitor',
      type: 'trend',
      title: `KnowledgeSync cycle: ${stale.length} stale, ${unmonitored.length} unmonitored, ${healed.length} healed`,
      content: [
        `Stale entries: ${stale.length}`,
        `Unmonitored: ${unmonitored.length}`,
        `Healed: ${healed.length}`,
        `Duration: ${durationMs}ms`,
        stale.length > 0 ? `Stale scopes: ${stale.map(s => s.scope).join(', ')}` : '',
        unmonitored.length > 0 ? `Unmonitored: ${unmonitored.map(u => `${u.scope}(${u.reason})`).join(', ')}` : '',
      ].filter(Boolean).join('\n'),
      severity: stale.length > 0 || unmonitored.length > 0 ? 'warning' : 'info',
      timestamp: Date.now(),
    }).catch(() => {});

    logger.debug('[KnowledgeSync] cycle complete', { durationMs, stale: stale.length, unmonitored: unmonitored.length, healed: healed.length });

    if (unmonitored.length > 0) {
      logger.warn('[KnowledgeSync] Unmonitored design-docs detected (auto-registered)', {
        unmonitored: unmonitored.map(u => ({ scope: u.scope, reason: u.reason })),
      });
    }

    logger.info('[KnowledgeSync] Sync cycle complete', {
      durationMs,
      scopesTracked: Object.keys(this.registry).length,
      staleCount: stale.length,
      unmonitoredCount: unmonitored.length,
      healedCount: healed.length,
      tokensUsed: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, model: 'system' },
    });

    return { stale, unmonitored, healed };
  }
}

export const knowledgeSync = new KnowledgeSyncService();
