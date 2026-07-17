/**
 * Auditor Agent — 跨任务审计 + 周期洞察
 *
 * 2026-05-09: 初始实现。每日扫描审计事件和执行结果，产出入门级洞察。
 * 远期 B4-001：系统级 GC + 模型 tier 成功率矩阵 + 约束效果评估。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, FileStore } from '@dommaker/studio-shared';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';

const fileStore = new FileStore();
import { knowledgeService } from '../knowledge/knowledge-service.js';
import { skillStore } from '../skills/skill-store.js';

const AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
const SYSTEM_CHANNEL_NAME = '#系统';
const STUDIO_EVENTS_JSONL = path.join(os.homedir(), 'events', 'studio.jsonl');

interface Suggestion {
  type: 'skill_weight' | 'skill_status' | 'param_tuning' | 'prompt_optimization'
       | 'model_weight_tune' | 'derived_rule_promote' | 'scope_stale_alert' | 'circuit_fix';
  risk: 'low' | 'high';
  skillId?: string;
  skillName?: string;
  agentType?: string;
  detail: string;
  data?: Record<string, unknown>;
}

export class AuditorAgent {
  private interval: NodeJS.Timeout | null = null;
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dailyAudit(), AUDIT_INTERVAL_MS);
    logger.info('[AuditorAgent] Started', { interval: '24h' });
    // 首次启动 5 分钟后跑一次
    setTimeout(() => this.dailyAudit(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    logger.info('[AuditorAgent] Stopped');
  }

  // ── Daily Audit ──

  private async dailyAudit(): Promise<void> {
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // 1. 过去 24h 的执行统计（含 agentType 用于 3D 分析）
      const allSnapshots = await this.fileStore.getIndex();
      const recentExecs = allSnapshots.filter(s => {
        if (!s.completedAt || !s.parentId) return false;
        return new Date(s.completedAt).getTime() >= yesterday.getTime();
      });
      const total = recentExecs.length;
      const failed = recentExecs.filter(e => e.status === 'closed').length;
      const successRate = total > 0 ? Math.round((1 - failed / total) * 100) : 100;

      // 2. 失败归类（全局 + 按 agent-type）
      const errorCounts = new Map<string, number>();
      const errorByAgentType = new Map<string, Map<string, number>>();
      for (const e of recentExecs) {
        const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
        if (e.status !== 'closed' || !eMeta.error) continue;
        const errorType = this.classifyError(eMeta.error as string);
        errorCounts.set(errorType, (errorCounts.get(errorType) || 0) + 1);

        const agentType = eMeta.agentType || 'unknown';
        if (!errorByAgentType.has(agentType)) {
          errorByAgentType.set(agentType, new Map());
        }
        const perType = errorByAgentType.get(agentType)!;
        perType.set(errorType, (perType.get(errorType) || 0) + 1);
      }

      // 3. 最近 24h 的审计事件统计 (KnowledgeStore)
      const { sharedStore: auditStore } = await import('../knowledge/knowledge-bus.service.js');
      const auditEntries = auditStore.list({ tags: ['audit'] });
      const auditCount = auditEntries.filter((e: any) =>
        new Date(e.created).getTime() >= yesterday.getTime()
      ).length;

      // 4. Agent-type × tier 3D 交叉分析
      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const tierStats = new Map<string, { total: number; failed: number }>();

      for (const e of recentExecs) {
        const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
        const agentType = eMeta.agentType || 'unknown';
        const ag = agentTypeStats.get(agentType) || { total: 0, failed: 0 };
        ag.total++;
        if (e.status === 'closed') ag.failed++;
        agentTypeStats.set(agentType, ag);

        // Extract modelTier from input JSON or default to 'standard'
        let tier = 'standard';
        try {
          if (eMeta.input) {
            const parsed = typeof eMeta.input === 'string' ? JSON.parse(eMeta.input) : eMeta.input;
            tier = (parsed as any)?.modelTier || 'standard';
          }
        } catch { /* use default */ }
        const tr = tierStats.get(tier) || { total: 0, failed: 0 };
        tr.total++;
        if (e.status === 'closed') tr.failed++;
        tierStats.set(tier, tr);
      }

      // 5. WorkUnit 状态分布
      const filteredForGroup = allSnapshots.filter(s => {
        if (!s.parentId || s.type !== 'task') return false;
        return new Date(s.updatedAt).getTime() >= yesterday.getTime();
      });
      const statusCounts = new Map<string, number>();
      for (const s of filteredForGroup) {
        statusCounts.set(s.status, (statusCounts.get(s.status) || 0) + 1);
      }
      const goalStats = [...statusCounts.entries()].map(([status, _count]) => ({ status, _count }));

      const summary = [
        `## 📊 每日审计 — ${now.toISOString().slice(0, 10)}`,
        '',
        '### 执行统计',
        `- 总执行: ${total} | 成功: ${total - failed} | 失败: ${failed} | 成功率: ${successRate}%`,
        `- 审计事件: ${auditCount}`,
        '',
        '### 按 Agent 类型',
        ...[...agentTypeStats.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([type, s]) => {
            const rate = s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100;
            return `- **${type}**: ${s.total} 次 (成功: ${s.total - s.failed}, 失败: ${s.failed}, 成功率: ${rate}%)`;
          }),
        '',
        '### 按模型档位',
        ...[...tierStats.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([tier, s]) => {
            const rate = s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100;
            return `- **${tier}**: ${s.total} 次 (成功: ${s.total - s.failed}, 失败: ${s.failed}, 成功率: ${rate}%)`;
          }),
        '',
        '### WorkUnit 状态',
        ...goalStats.map(g => `- ${g.status}: ${g._count}`),
      ];

      if (errorCounts.size > 0) {
        summary.push('', '### 失败归类', ...[...errorCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `- ${type}: ${count}`));
      }

      if (failed > 0 && successRate < 80) {
        summary.push('', '### ⚠️ 关注', `成功率 ${successRate}% < 80%，建议人工检查失败原因。`);
      }

      const content = summary.join('\n');

      // 6. 用户模型质量分析
      const modelSuggestions = await this.analyzeUserModel();
      // 知识电路健康分析
      const circuitSuggestions = await this.analyzeCircuitHealth();

      // 7. 生成审计建议 → 分权限执行
      const suggestions = [
        ...await this.generateSuggestions(agentTypeStats, errorByAgentType),
        ...modelSuggestions,
        ...circuitSuggestions,
      ];
      const lowRisk = suggestions.filter(s => s.risk === 'low');
      const highRisk = suggestions.filter(s => s.risk === 'high');

      const appliedSummary = await this.applyLowRiskSuggestions(lowRisk);
      if (appliedSummary.length > 0) {
        summary.push('', '### 已自动应用', ...appliedSummary.map(s => `- ✅ ${s}`));
      }

      if (highRisk.length > 0) {
        await this.pushConfirmationCards(highRisk);
        summary.push('', '### 待人工确认', ...highRisk.map(s => `- ⚠️ ${s.detail}`));
      }

      const finalContent = summary.join('\n');

      // 新增: 用户模型 + 电路健康摘要
      if (modelSuggestions.length > 0) {
        summary.push('', '### 用户模型质量', ...modelSuggestions.map(s => `- ${s.risk === 'high' ? '⚠️' : '📊'} ${s.detail}`));
      }
      if (circuitSuggestions.length > 0) {
        summary.push('', '### 知识电路健康', ...circuitSuggestions.map(s => `- ${s.risk === 'high' ? '🔴' : '🟡'} ${s.detail}`));
      }

      // 8. 推送到 #系统 channel
      await this.postToSystemChannel(finalContent);

      // 8. Escalate anomalies to Triage (Phase 3)
      await this.escalateToTriage(agentTypeStats, successRate, total, failed);

      // 9. 保存 tier 成功率 → Analyst 反馈回路
      await this.saveTierStats(tierStats);

      // 10. Better-Harness: 失败 → eval case 生成
      const execsForEval = recentExecs.map(e => {
        const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
        return { id: e.id, goalId: e.parentId ?? undefined, status: e.status, error: eMeta.error ?? null, agentType: eMeta.agentType ?? null, input: eMeta.input ?? null };
      });
      await this.generateEvalCases(execsForEval);

      // RKB: 对新 error pattern 自动创建 pending Resolution
      const execsForRes = recentExecs.map(e => {
        const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
        return { status: e.status, error: eMeta.error ?? null, agentType: eMeta.agentType ?? null };
      });
      await this.autoCreateResolutions(execsForRes);

      // Doc Freshness: 处理 CI 创建的 doc-freshness issues
      await this.handleDocFreshnessIssues();

      // 开发会话行为趋势 (session:summary → behavioral insights)
      const sessionTrends = await this.analyzeSessionTrends(yesterday);
      if (sessionTrends.length > 0) {
        summary.push('', '### 开发会话行为趋势', ...sessionTrends);
      }

      // Record audit findings to KnowledgeService
      knowledgeService.recordPattern({
        type: 'trend',
        title: `[Auditor] Daily audit ${now.toISOString().slice(0, 10)}: ${total} execs, ${successRate}% success`,
        content: summary.filter(l => l.startsWith('-')).join('\n'),
        tags: ['auditor'],
      }).catch(() => { /* non-blocking */ });

      logger.info('[AuditorAgent] Daily audit completed', { total, failed, successRate });
    } catch (e) {
      logger.error('[AuditorAgent] Daily audit failed', { error: String(e) });
    }
  }

  // ── Error Classification ──

  /**
   * 分析开发会话行为趋势 (session:summary → behavioral insights)
   *
   * 读取 ~/events/studio.jsonl 中的 session:summary 事件，
   * 聚合最近 24h 的行为信号，产出入门级洞察。
   * 不自动进化约束 — 行为约束的执行机制（Claude Code hooks）与代码约束（harness check）不同。
   */
  private async analyzeSessionTrends(since: Date): Promise<string[]> {
    const lines: string[] = [];
    try {
      const eventsFile = path.join(os.homedir(), 'events', 'studio.jsonl');
      if (!fs.existsSync(eventsFile)) return [];

      const raw = fs.readFileSync(eventsFile, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'session:summary' && new Date(evt.timestamp) >= since) {
            lines.push(line);
          }
        } catch {}
      }
    } catch { return []; }

    if (lines.length === 0) return [];

    // Aggregate metrics
    let totalSessions = 0;
    let deepAnalysisCount = 0;
    let missingCaptureCount = 0;
    let sensitiveOpsSessions = 0;
    let highSensitiveOpsCount = 0;
    let totalTurnCount = 0;
    let maxTurnCount = 0;

    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        totalSessions++;
        if (evt.deepAnalysis) deepAnalysisCount++;
        if (evt.deepAnalysis && !evt.knowledgeCaptured) missingCaptureCount++;
        if (evt.sensitiveOpsCount > 0) sensitiveOpsSessions++;
        if (evt.sensitiveOpsCount >= 3) highSensitiveOpsCount++;
        totalTurnCount += (evt.turnCount || 0);
        if ((evt.turnCount || 0) > maxTurnCount) maxTurnCount = evt.turnCount;
      } catch {}
    }

    const insights: string[] = [];

    // Knowledge capture health
    if (totalSessions > 0) {
      const captureRate = deepAnalysisCount > 0
        ? Math.round((1 - missingCaptureCount / deepAnalysisCount) * 100)
        : 100;
      insights.push(`- 开发会话: ${totalSessions} 次 | 深度分析: ${deepAnalysisCount} | 知识捕获率: ${captureRate}%`);
    }

    // Sensitive ops trend
    if (sensitiveOpsSessions > 0) {
      const pct = Math.round((sensitiveOpsSessions / Math.max(totalSessions, 1)) * 100);
      insights.push(`- ⚠️  ${sensitiveOpsSessions}/${totalSessions} 会话有未验证敏感操作 (${pct}%)`);

      if (sensitiveOpsSessions >= 3) {
        insights.push('  - 📋 建议：review `feedback_verify_before_move.md` 规则是否需要加强');
      }
      if (highSensitiveOpsCount >= 2) {
        insights.push('  - 🔴 多个会话高频触发敏感操作检测，考虑加强 hook 拦截力度');
      }
    }

    // Knowledge capture degradation
    if (deepAnalysisCount >= 3 && missingCaptureCount >= deepAnalysisCount * 0.5) {
      insights.push(`- ⚠️  知识捕获率 < 50% (${missingCaptureCount}/${deepAnalysisCount} 会话深度分析无产出)`);
      insights.push('  - 📋 建议：运行 `npx harness sync-docs`，检查 `ingest:true` 标记是否遗漏');
    }

    // Session length anomaly
    if (maxTurnCount > 50) {
      insights.push(`- ⚠️  最长会话 ${maxTurnCount} turns — 考虑运行 cstnew 清理长会话`);
    }

    if (totalSessions > 0) {
      const avgTurns = Math.round(totalTurnCount / totalSessions);
      if (avgTurns > 30) {
        insights.push(`- 📊 平均会话 ${avgTurns} turns — 偏高，建议拆分大任务为小 session`);
      }
    }

    // B13-011: Save daily snapshot + detect multi-day trends
    const snapshot = {
      date: since.toISOString().slice(0, 10),
      totalSessions,
      deepAnalysisCount,
      missingCaptureCount,
      sensitiveOpsSessions,
      highSensitiveOpsCount,
      avgTurns: totalSessions > 0 ? Math.round(totalTurnCount / totalSessions) : 0,
      maxTurnCount,
    };

    try {
      const trendInsights = this.trackTrends(snapshot);
      if (trendInsights.length > 0) {
        insights.push('', '### 趋势变化（7 日对比）', ...trendInsights);
      }
    } catch { /* non-blocking */ }

    return insights;
  }

  /**
   * B13-011: 保存每日快照 + 检测趋势变化
   *
   * 快照存储：~/.studio/auditor/daily-snapshots.jsonl
   * 每行一个 JSON 对象，保留 30 天。
   */
  private trackTrends(snapshot: {
    date: string; totalSessions: number; deepAnalysisCount: number;
    missingCaptureCount: number; sensitiveOpsSessions: number;
    highSensitiveOpsCount: number; avgTurns: number; maxTurnCount: number;
  }): string[] {
    const auditorDir = path.join(os.homedir(), '.studio', 'auditor');
    fs.mkdirSync(auditorDir, { recursive: true });
    const snapshotFile = path.join(auditorDir, 'daily-snapshots.jsonl');

    // Load existing snapshots
    let snapshots: typeof snapshot[] = [];
    try {
      const raw = fs.readFileSync(snapshotFile, 'utf-8');
      snapshots = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { /* file doesn't exist yet */ }

    // Dedup by date (keep latest for today)
    snapshots = snapshots.filter(s => s.date !== snapshot.date);
    snapshots.push(snapshot);

    // Keep last 30 days
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
    if (snapshots.length > 30) snapshots = snapshots.slice(-30);

    // Write back
    fs.writeFileSync(snapshotFile, snapshots.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf-8');

    // Need at least 3 days of history for trend detection
    if (snapshots.length < 3) return [];

    // Compare current vs 7-day average (excluding today)
    const prev = snapshots.slice(0, -1);
    const window = prev.slice(-7);
    if (window.length < 2) return [];

    const avg = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;

    const prevSensitiveOps = avg(window.map(s => s.sensitiveOpsSessions));
    const prevCaptureRate = avg(window.map(s =>
      s.deepAnalysisCount > 0 ? (1 - s.missingCaptureCount / s.deepAnalysisCount) * 100 : 100
    ));
    const prevAvgTurns = avg(window.map(s => s.avgTurns));

    const currentCaptureRate = snapshot.deepAnalysisCount > 0
      ? (1 - snapshot.missingCaptureCount / snapshot.deepAnalysisCount) * 100
      : 100;

    const insights: string[] = [];

    // Sensitive ops increasing
    if (snapshot.sensitiveOpsSessions > prevSensitiveOps * 1.5 && snapshot.sensitiveOpsSessions >= 2) {
      insights.push(`- 🔴 敏感操作会话数上升: ${snapshot.sensitiveOpsSessions}（7日均值 ${prevSensitiveOps.toFixed(1)}），需关注`);
    }

    // Capture rate declining
    if (currentCaptureRate < prevCaptureRate - 15 && snapshot.deepAnalysisCount >= 2) {
      insights.push(`- 📉 知识捕获率下降: ${Math.round(currentCaptureRate)}%（7日均值 ${Math.round(prevCaptureRate)}%）`);
    }

    // Session length increasing
    if (snapshot.avgTurns > prevAvgTurns * 1.3 && snapshot.avgTurns > 20) {
      insights.push(`- 📈 平均会话长度上升: ${snapshot.avgTurns} turns（7日均值 ${Math.round(prevAvgTurns)}）`);
    }

    return insights;
  }

  private classifyError(errorMsg: string): string {
    const msg = (typeof errorMsg === 'string' ? errorMsg : String(errorMsg)).toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('docker') || msg.includes('container')) return 'docker';
    if (msg.includes('git') || msg.includes('worktree')) return 'git/worktree';
    if (msg.includes('prisma') || msg.includes('database') || msg.includes('sqlite')) return 'database';
    if (msg.includes('type') || msg.includes('tsc') || msg.includes('lint')) return 'type/lint';
    if (msg.includes('test')) return 'test_failure';
    if (msg.includes('port') || msg.includes('eaddrinuse')) return 'port_conflict';
    if (msg.includes('permission') || msg.includes('denied')) return 'permission';
    if (msg.includes('model') || msg.includes('token') || msg.includes('llm')) return 'llm/model';
    return 'other';
  }

  /**
   * RKB: 对未见过的错误 pattern 自动创建 pending Resolution
   *
   * 只对 L3/L4 层的运维配置类错误（permission/config/docker/git）自动创建，
   * 代码类错误（type/lint/test）留给开发者处理。
   */
  private async autoCreateResolutions(
    recentExecs: Array<{ status: string; error: string | null; agentType: string | null }>,
  ): Promise<void> {
    const opsErrorClasses = new Set(['permission', 'docker', 'git/worktree', 'port_conflict', 'llm/model']);
    try {
      const { resolutionService } = await import('../knowledge/resolution.service.js');

      for (const e of recentExecs) {
        if (e.status !== 'closed' || !e.error) continue;
        const errorClass = this.classifyError(e.error as string);
        if (!opsErrorClasses.has(errorClass)) continue;

        // Extract key pattern from error message (first 120 chars, trim noise)
        const pattern = e.error.slice(0, 120).replace(/[\n\r]/g, ' ').trim();
        if (pattern.length < 10) continue;

        // Check if resolution already exists
        const { matched } = await resolutionService.matchResolutions({ errorMessage: pattern, errorClass });
        if (matched) continue; // Already covered

        // Create pending resolution
        await resolutionService.createResolution({
          pattern,
          errorClass,
          layer: errorClass === 'permission' || errorClass === 'port_conflict' ? 'L4_env_config' : 'L3_tool_behavior',
          title: `${errorClass}: ${pattern.slice(0, 60)}`,
          fix: '（待人工补充解法）',
          tags: [errorClass, 'auto-detected'],
        });
      }
    } catch (err) {
      logger.warn('[AuditorAgent] autoCreateResolutions failed', { error: String(err) });
    }
  }

  // ── Triage Escalation (Phase 3) ──

  private async escalateToTriage(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    overallSuccessRate: number,
    total: number,
    failed: number,
  ): Promise<void> {
    // Check per-agent-type: >30% failure rate for any type → agent_type_failure_trend
    for (const [agentType, stats] of agentTypeStats) {
      if (stats.total >= 3) {
        const failureRate = stats.failed / stats.total;
        if (failureRate > 0.3) {
          try {
            const { triageAgent } = await import('./triage-agent.service.js');
            triageAgent.handleAlert({
              type: 'agent_type_failure_trend',
              severity: 'critical',
              message: `Agent type "${agentType}" failure rate ${(failureRate * 100).toFixed(0)}% (${stats.failed}/${stats.total})`,
              details: {
                failingAgentType: agentType,
                failureRate: Math.round(failureRate * 100),
                total: stats.total,
                failed: stats.failed,
              },
            }).catch(err => {
              logger.error('[AuditorAgent] Triage escalation failed (agent_type)', {
                agentType,
                error: String(err),
              });
            });
          } catch (err) {
            logger.warn('[AuditorAgent] Failed to import triageAgent for agent_type_failure_trend', { error: String(err) });
          }
        }
      }
    }

    // Overall successRate < 50% → workunit_health_degraded
    if (total >= 5 && overallSuccessRate < 50) {
      try {
        const { triageAgent } = await import('./triage-agent.service.js');
        triageAgent.handleAlert({
          type: 'workunit_health_degraded',
          severity: 'critical',
          message: `WorkUnit success rate ${overallSuccessRate}% (${failed}/${total} failed) below 50% threshold`,
          details: {
            overallSuccessRate,
            total,
            failed,
          },
        }).catch(err => {
          logger.error('[AuditorAgent] Triage escalation failed (workunit_health)', {
            error: String(err),
          });
        });
      } catch (err) {
        logger.warn('[AuditorAgent] Failed to import triageAgent for workunit_health_degraded', { error: String(err) });
      }
    }
  }

  // ── User Model Quality Analysis ──

  private async analyzeUserModel(): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];
    try {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');

      // Read user model state (written by update-user-model)
      const stateFile = path.join(os.homedir(), '.claude', 'user-model-state.json');
      if (!fs.existsSync(stateFile)) return suggestions;

      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const patterns = state.patterns || {};

      // 1. Semantic cluster stability: clusters with >5 occurrences but still "new" → suggest stabilize
      for (const [concept, p] of Object.entries(patterns) as [string, any][]) {
        if (p.occurrences >= 5 && p.trend === 'rising') {
          suggestions.push({
            type: 'model_weight_tune',
            risk: 'low',
            detail: `概念 "${concept}" 出现 ${p.occurrences} 次，趋势 rising → 建议固化权重`,
            data: { concept, occurrences: p.occurrences, sessions: p.sessions?.length },
          });
        }
        // 2. Falling patterns: was stable, now declining → check if should retire
        if (p.trend === 'falling' && p.occurrences >= 3) {
          suggestions.push({
            type: 'model_weight_tune',
            risk: 'low',
            detail: `概念 "${concept}" 趋势 falling → 建议降权`,
            data: { concept, occurrences: p.occurrences, trend: 'falling' },
          });
        }
      }

      // 3. Lens weight drift: compare current weights vs baseline
      const lensWeights = state.lensWeights || {};
      for (const [lens, weight] of Object.entries(lensWeights) as [string, number][]) {
        if (weight >= 3) {
          suggestions.push({
            type: 'derived_rule_promote',
            risk: 'high',
            detail: `Lens "${lens}" 权重 ${weight} ≥ 3 → 建议升级为硬约束`,
            data: { lens, weight },
          });
        }
      }
    } catch (e: any) {
      logger.warn('[AuditorAgent] User model analysis failed', { error: String(e) });
    }
    return suggestions;
  }

  // ── Knowledge Circuit Health (I2) ──

  /**
   * 分析知识电路的连通性：
   * - 读/写比例 → 检测"只写不读"的断点
   * - 跨 agent 引用率 → 检测知识孤岛
   * - 总条目数 → 检测冷电路
   */
  private async analyzeCircuitHealth(): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];
    try {
      const stats = knowledgeService.getStats();
      const total = stats.total || 0;

      // Circuit 1: 冷电路 — 知识总线为空
      if (total === 0) {
        suggestions.push({
          type: 'circuit_fix',
          risk: 'high',
          agentType: 'auditor',
          detail: `知识总线为空 — 管线运行多轮仍未沉淀任何知识。建议：① 确认 Auditor 日审已启用；② 检查 KnowledgeBus.recordPattern() 写入链路；③ 排查 harness trace → knowledge 同步`,
        });
        return suggestions;
      }

      // Circuit 2: 总条目低于阈值
      if (total < 10) {
        suggestions.push({
          type: 'circuit_fix',
          risk: 'high',
          agentType: 'auditor',
          detail: `知识总线仅 ${total} 条记录 — 知识积累速度过低。建议：检查 RKB seed 是否已写入、Monitor/Auditor/Triage 的知识写入回路是否正常`,
        });
      }

      // Circuit 3: 按类型分布 — 检测断点
      const byType = Object.entries(stats).filter(([k]) => k !== 'total');
      const typeSummary = byType.map(([k, v]) => `${k}:${v}`).join(', ');

      // Circuit 4: 无跨 agent 引用 — 知识孤岛
      if (byType.length <= 1 && total > 0) {
        suggestions.push({
          type: 'circuit_fix',
          risk: 'high',
          agentType: 'auditor',
          detail: `知识总线仅有 ${byType.length} 种类型 (${typeSummary}) — 所有知识来自同一个 source，存在知识孤岛风险。跨 agent 知识闭环未形成`,
        });
      }

      // Circuit 5: CONTEXT.md 覆盖率 — 关键目录缺索引则 Analysist 每次都重探索
      try {
        const fs = require('fs');
        const p = require('path');
        const modulesDir = p.join(process.env.REPO_DIR || process.cwd(), 'apps/api/src/modules');
        if (fs.existsSync(modulesDir)) {
          const dirs = fs.readdirSync(modulesDir, { withFileTypes: true })
            .filter((d: any) => d.isDirectory() && d.name !== '__tests__');
          const missing: string[] = [];
          for (const d of dirs) {
            const ctxPath = p.join(modulesDir, d.name, 'CONTEXT.md');
            if (!fs.existsSync(ctxPath)) missing.push(d.name);
          }
          if (missing.length > 0) {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'low',
              agentType: 'auditor',
              detail: `${missing.length} 个模块目录缺 CONTEXT.md: ${missing.join(', ')} — Analyst 每次探索都会重读代码。用 @Analyst 初始化即可。`,
            });
          }
        }
      } catch { /* non-blocking */ }

      // Circuit 7: OKR 达成率 (B8 OKR 驱动闭环)
      try {
        const { okrService } = await import('../pmo/okr.service.js');
        // Read OKR files from ~/.studio/okr/
        const okrDir = path.join(os.homedir(), '.studio', 'okr');
        const okrKeys = await this.fileStore.listDocs(okrDir);
        const okrs: any[] = [];
        for (const key of okrKeys) {
          const doc = await this.fileStore.readDoc(okrDir, key);
          if (doc && doc.meta.status === 'active') {
            okrs.push({ id: doc.meta.id, meta: doc.meta, body: doc.body });
          }
        }
        for (const okr of okrs) {
          const krs: any[] = typeof (okr as any).meta.keyResults === 'string' ? JSON.parse((okr as any).meta.keyResults) : ((okr as any).meta.keyResults as any[]) || [];
          for (const kr of krs) {
            if (!kr.metricType || !kr.target || kr.target <= 0) continue;

            const ds = okrService ? 'ok' : 'empty'; // service exists
            if (!ds) continue;

            // Query KR history for trend from ~/.studio/okr/kr-history.jsonl
            let allHistory: any[] = [];
            try {
              const krHistoryPath = path.join(os.homedir(), '.studio', 'okr', 'kr-history.jsonl');
              allHistory = await this.fileStore.readJsonl<any>(krHistoryPath);
            } catch { /* no history yet */ }
            const history = allHistory
              .filter((h: any) => h.okrId === okr.id && h.krId === kr.id)
              .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
              .slice(0, 7);

            const latest = history[0];
            if (!latest) continue;

            if (latest.status === 'no_data') {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.meta.title}" KR "${kr.title}": 数据暂不可用 (metricType: ${kr.metricType})`,
              });
              continue;
            }

            if (latest.status === 'stale') {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.meta.title}" KR "${kr.title}": 数据已过期`,
              });
              continue;
            }

            const ratio = latest.value / kr.target;
            const trend = history.length >= 2
              ? (latest.value - history[history.length - 1].value) / history[history.length - 1].value
              : 0;

            if (ratio < 0.6 && trend <= 0) {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'high',
                agentType: 'auditor',
                detail: `OKR "${okr.meta.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，趋势${trend < 0 ? '恶化中' : '未改善'}。建议触发深度根因分析`,
              });

              // 纯代码创建 okr_proposal WorkUnit（不调 LLM）
              // Agent 领取后自行诊断，有完整系统上下文
              const now = new Date().toISOString();
              const wuId = `okr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              const metadata = {
                okrId: okr.id,
                krId: kr.id,
                krTitle: kr.title,
                attainment: ratio,
                trend: trend < 0 ? 'down' : 'stable',
                currentValue: latest.value,
                targetValue: kr.target,
                historyCount: history.length,
              };

              // 创建 WorkUnit（通过 fileStore.upsertSnapshot）
              try {
                const snapshot = {
                  id: wuId,
                  parentId: null,
                  type: 'okr_proposal',
                  scope: `[OKR优化] ${kr.title}: 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})`,
                  assigneeId: null,
                  status: 'unassigned' as const,
                  failureType: null,
                  retryCount: 0,
                  timeoutAt: null,
                  channelId: null,
                  projectPath: null,
                  metadata: JSON.stringify(metadata),
                  createdAt: now,
                  updatedAt: now,
                  claimedAt: null,
                  completedAt: null,
                };
                await this.fileStore.upsertSnapshot(snapshot);
              } catch {}
            } else if (ratio < 0.8) {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.meta.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，低于目标`,
              });
            }

            // 🆕 B8 Phase 1.5: 重校准 — baseline 已超 target 时建议上调
            if (ratio > 1.05) {
              const suggested = Math.ceil(latest.value * 1.02);
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.meta.title}" KR "${kr.title}": 当前实际 ${latest.value}${kr.unit || ''} 已超过目标 ${kr.target}${kr.unit || ''} (${Math.round(ratio * 100)}%)。建议上调 target 至 >= ${suggested}${kr.unit || ''}`,
              });
            }
          }
        }
      // Circuit 8: Memory→KnowledgeStore sync health
      try {
        const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
        const knowledgeDir = process.env.KNOWLEDGE_BASE_DIR || path.join(os.homedir(), '.studio', 'knowledge');
        if (fs.existsSync(memoryDir) && fs.existsSync(knowledgeDir)) {
          const batchFiles = fs.readdirSync(memoryDir)
            .filter(f => f.startsWith('project_batch_progress_') && f.endsWith('.md'))
            .sort()
            .slice(-3); // last 3 batch progress files

          const knowledgeFiles = new Set(fs.readdirSync(knowledgeDir));
          const missing: string[] = [];
          for (const f of batchFiles) {
            const expected = `process-batch_progress_${f.replace('project_batch_progress_', '').replace('.md', '')}.md`;
            if (!knowledgeFiles.has(expected)) {
              missing.push(f);
            }
          }
          if (missing.length > 0) {
            suggestions.push({
              type: 'circuit_fix',
              risk: 'high',
              agentType: 'auditor',
              detail: `${missing.length} 个 batch progress 文件未同步到 KnowledgeStore: ${missing.join(', ')}。检查 memory 文件的 frontmatter 是否有 maturity 字段 (draft 会被跳过)`,
            });
          }
        }
      } catch { /* non-blocking */ }

      } catch (e) {
        logger.warn('[AuditorAgent] OKR circuit health check failed', { error: String(e) });
      }

      logger.info('[AuditorAgent] Circuit health analyzed', { total, typeCount: byType.length, types: typeSummary });
    } catch (e) {
      logger.warn('[AuditorAgent] Circuit health analysis failed', { error: String(e) });
    }
    return suggestions;
  }

  // ── Generate Suggestions (B3-005) ──

  private async generateSuggestions(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    errorByAgentType: Map<string, Map<string, number>>,
  ): Promise<Suggestion[]> {
    const suggestions: Suggestion[] = [];

    try {
      // Skip if insufficient active sessions (4-week window)
      const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 3600_000);
      // Read studio events from JSONL
      let activeSessionCount = 0;
      try {
        const allEvents = await this.fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
        activeSessionCount = allEvents.filter(
          (e: any) => e.type === 'session:summary' && new Date(e.timestamp).getTime() >= fourWeeksAgo.getTime()
        ).length;
      } catch { activeSessionCount = 0; }

      if (activeSessionCount < 5) {
        logger.info('[AuditorAgent] Skipping skill audit — insufficient active sessions', { activeSessionCount });
      } else {
        // Query skills with sufficient usage for analysis
        const skills = skillStore.list({ usageCount: { gte: 3 } });

        for (const skill of skills) {
          const successPct = Math.round(skill.successRate * 100);

          // skill_underperform: successRate < 50% → suggest optimize prompt
          if (skill.successRate < 0.5 && skill.status === 'published') {
            suggestions.push({
              type: 'skill_weight',
              risk: 'low',
              skillId: skill.id,
              skillName: skill.name,
              detail: `Skill "${skill.name}" 成功率 ${successPct}% < 50%，建议优化 prompt`,
              data: { successRate: skill.successRate, usageCount: skill.usageCount },
            });
          }

          // skill_auto_publish: successRate >= 80% + draft → auto publish
          if (skill.successRate >= 0.8 && skill.status === 'draft') {
            suggestions.push({
              type: 'skill_status',
              risk: 'low',
              skillId: skill.id,
              skillName: skill.name,
              detail: `Skill "${skill.name}" 成功率达 ${successPct}%，建议发布`,
              data: { successRate: skill.successRate, currentStatus: skill.status },
            });
          }

          // skill_auto_demote: successRate < 30% + published → demote to draft
          if (skill.successRate < 0.3 && skill.status === 'published') {
            suggestions.push({
              type: 'skill_weight',
              risk: 'high',
              skillId: skill.id,
              skillName: skill.name,
              detail: `Skill "${skill.name}" 成功率 ${successPct}% < 30%，自动降级为 draft`,
              data: { successRate: skill.successRate, action: 'demote' },
            });
          }

          // skill_retire: deprecated + 0 recent usage → physical delete
          if (skill.status === 'deprecated') {
            let recentUsage = 0;
            try {
              const allEvents = await this.fileStore.readJsonl<any>(STUDIO_EVENTS_JSONL);
              recentUsage = allEvents.filter(
                (e: any) => e.type === 'skill:used'
                  && new Date(e.timestamp).getTime() >= fourWeeksAgo.getTime()
                  && String(e.payload || '').includes(skill.id)
              ).length;
            } catch { recentUsage = 0; }
            if (recentUsage === 0) {
              suggestions.push({
                type: 'skill_status',
                risk: 'high',
                skillId: skill.id,
                skillName: skill.name,
                detail: `Skill "${skill.name}" 已废弃且 4 周内无使用，建议删除`,
                data: { action: 'retire' },
              });
            }
          }
        }

        // skill_inactive: usage rate < 10% in 4-week window
        for (const skill of skills) {
          if (skill.status !== 'published') continue;
          const usageRate = skill.usageCount / activeSessionCount;
          if (usageRate < 0.1) {
            suggestions.push({
              type: 'skill_weight',
              risk: 'low',
              skillId: skill.id,
              skillName: skill.name,
              detail: `Skill "${skill.name}" 使用率 ${(usageRate * 100).toFixed(0)}% < 10%，建议废弃`,
              data: { usageRate, usageCount: skill.usageCount, activeSessionCount },
            });
          }
        }
      }

      // Detection rule 3: param_tuning — agent-type timeout errors >= 3
      for (const [agentType, errorMap] of errorByAgentType) {
        const timeoutCount = errorMap.get('timeout') || 0;
        const totalErrors = [...errorMap.values()].reduce((a, b) => a + b, 0);
        const stats = agentTypeStats.get(agentType);
        const execTotal = stats?.total || 0;

        if (timeoutCount >= 3 && totalErrors >= 5) {
          suggestions.push({
            type: 'param_tuning',
            risk: 'high',
            agentType,
            detail: `${agentType} 超时错误 ${timeoutCount}/${totalErrors}，建议调整 sessionTimeoutMinutes`,
            data: { agentType, timeoutCount, totalErrors, execTotal },
          });
        }

        // Detection rule 4: prompt_optimization — agent-type failureRate > 0.3 + llm/model dominant
        if (stats && stats.total >= 5) {
          const failureRate = stats.failed / stats.total;
          const llmErrors = errorMap.get('llm/model') || 0;
          if (failureRate > 0.3 && llmErrors >= totalErrors * 0.4) {
            suggestions.push({
              type: 'prompt_optimization',
              risk: 'high',
              agentType,
              detail: `${agentType} 失败率 ${(failureRate * 100).toFixed(0)}%，LLM/模型错误占主导 (${llmErrors}/${totalErrors})，建议优化 prompt`,
              data: { agentType, failureRate: Math.round(failureRate * 100), llmErrors, totalErrors },
            });
          }
        }
      }
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to generate suggestions', { error: String(err) });
    }

    return suggestions;
  }

  // ── Apply Low-Risk Suggestions (B3-005) ──

  private async applyLowRiskSuggestions(suggestions: Suggestion[]): Promise<string[]> {
    const applied: string[] = [];

    for (const s of suggestions) {
      try {
        if (s.type === 'skill_weight' && s.skillId) {
          skillStore.update(s.skillId, {
            successRate: s.data?.successRate as number,
          });
          applied.push(`Skill "${s.skillName}" successRate updated`);
          logger.info('[AuditorAgent] Auto-applied skill_weight', { skillId: s.skillId, skillName: s.skillName });
        } else if (s.type === 'skill_status' && s.skillId) {
          skillStore.update(s.skillId, { status: 'published' });
          applied.push(`Skill "${s.skillName}" auto-published`);
          logger.info('[AuditorAgent] Auto-applied skill_status', { skillId: s.skillId, skillName: s.skillName });
        } else if (s.type === 'model_weight_tune') {
          // Update user model state: mark concept trend as stable
          const fs = await import('fs');
          const path = await import('path');
          const os = await import('os');
          const stateFile = path.join(os.homedir(), '.claude', 'user-model-state.json');
          if (fs.existsSync(stateFile)) {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            const concept = s.data?.concept as string;
            if (state.patterns?.[concept]) {
              state.patterns[concept].trend = 'stable';
              fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
              applied.push(`概念 "${concept}" 趋势已固化为 stable`);
              logger.info('[AuditorAgent] Auto-applied model_weight_tune', { concept });
            }
          }
        } else if (s.type === 'circuit_fix' && s.risk === 'low') {
          // Low-risk circuit fix: just record that we tried
          applied.push(`电路建议已记录: ${s.detail.slice(0, 80)}`);
          logger.info('[AuditorAgent] Recorded circuit suggestion', { detail: s.detail });
        }
      } catch (err) {
        logger.warn('[AuditorAgent] Failed to apply low-risk suggestion', {
          type: s.type,
          skillId: s.skillId,
          error: String(err),
        });
      }
    }

    return applied;
  }

  // ── Push Confirmation Cards (B3-005) ──

  private async pushConfirmationCards(suggestions: Suggestion[]): Promise<void> {
    if (suggestions.length === 0) return;

    try {
      const channel = (await this.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
      if (!channel) {
        return;
      }

      const { channelMessageService } = await import('../channels/channel-message.service.js');

      // 1. Push cards to #系统 channel
      const content = [
        '## 🔧 审计建议 — 待人工确认',
        '',
        ...suggestions.map((s, i) => {
          const icon = s.type === 'param_tuning' ? '⚙️' : s.type === 'circuit_fix' ? '🔴' : '📝';
          return `${i + 1}. ${icon} **${s.detail}**`;
        }),
        '',
        '请确认是否执行以上建议。',
      ].join('\n');

      await channelMessageService.createCardMessage(
        channel.id,
        'Auditor',
        content,
        'auditor_suggestion',
        { suggestions, status: 'ready' },
      );

      // 2. Push bell notifications to all users
      try {
        const notifService = new NotificationService(fileStore);
        // Read users from FileStore
        const usersDir = path.join(os.homedir(), '.studio', 'data', 'users');
        let userIds: string[] = [];
        try {
          const entries = await fs.promises.readdir(usersDir, { withFileTypes: true });
          const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
          userIds = files.slice(0, 10).map(f => f.name.replace(/\.json$/, ''));
        } catch { /* no users dir */ }
        for (const uid of userIds) {
          await notifService.create({
            userId: uid,
            type: 'auditor_suggestion',
            title: `审计建议 (${suggestions.length} 项)`,
            content: suggestions.map(s => s.detail).join(' | '),
            link: `/channels/${channel.id}`,
          });
        }
        logger.info('[AuditorAgent] Push notifications sent', { users: userIds.length, suggestions: suggestions.length });
      } catch (notifErr: any) {
        logger.warn('[AuditorAgent] Bell notification failed (non-blocking)', { error: String(notifErr) });
      }

      logger.info('[AuditorAgent] Pushed suggestion confirmation cards + notifications', { count: suggestions.length });
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to push suggestion cards', { error: String(err) });
    }
  }

  // ── Save Tier Stats (Auditor → Analyst feedback loop) ──

  private async saveTierStats(
    tierStats: Map<string, { total: number; failed: number }>,
  ): Promise<void> {
    if (tierStats.size === 0) return;

    try {
      const stats = [...tierStats.entries()].map(([tier, s]) => ({
        tier,
        total: s.total,
        failed: s.failed,
        successRate: s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100,
      }));

      const { sharedStore: tierStatsStore } = await import('../knowledge/knowledge-bus.service.js');
      tierStatsStore.save({
        id: `tier-stats-${new Date().toISOString().slice(0, 10)}`,
        type: 'guideline' as any,
        title: 'tier_success_rate',
        content: JSON.stringify(stats),
        maturity: 'active' as any,
        layer: 'project',
        created: new Date().toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['auditor-agent'],
        projects: [],
        tags: ['audit', 'tier_stats'],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
        executionResults: [],
        consumptionMode: 'reference' as any,
        origin: 'agent' as any,
      } as any);

      logger.info('[AuditorAgent] Tier stats saved', { tiers: stats.length });
    } catch (err) {
      logger.warn('[AuditorAgent] Failed to save tier stats', { error: String(err) });
    }
  }

  // ── Eval Case Generation (Better-Harness hill-climbing) ──

  private async generateEvalCases(recentExecs: Array<{
    status: string;
    error: string | null;
    agentType: string | null;
    input: any;
    id?: string;
    goalId?: string;
  }>): Promise<void> {
    const failures = recentExecs
      .filter(e => e.status === 'closed' && e.error)
      .map(e => ({
        workUnitId: (e as any).goalId || 'unknown',
        executionId: (e as any).id || 'unknown',
        error: e.error!,
        taskDescription: this.extractTaskDescription(e.input),
        changedFiles: [],
        agentType: e.agentType || undefined,
      }));

    if (failures.length === 0) return;

    try {
      const { evalCaseGenerator } = await import('../knowledge/eval-case-generator.js');
      await evalCaseGenerator.generateFromFailures(failures);
    } catch (err) {
      logger.warn('[AuditorAgent] Eval case generation failed', { error: String(err) });
    }
  }

  private extractTaskDescription(input: any): string | undefined {
    try {
      if (!input) return undefined;
      const parsed = typeof input === 'string' ? JSON.parse(input) : input;
      return (parsed as any)?.taskDescription || (parsed as any)?.prompt?.substring?.(0, 200);
    } catch {
      return undefined;
    }
  }

  // ── Doc Freshness Issue Processing ──

  /**
   * 处理 CI 创建的 doc-freshness issues:
   * - numeric/status 差异: 自动修复 + 创建 PR
   * - narrative 差异: 添加分析评论，保持 issue open
   *
   * 依赖 `gh` CLI (GitHub Actions runner 或服务器上可用)。
   */
  private async handleDocFreshnessIssues(): Promise<void> {
    try {
      const { execSync } = await import('child_process');

      // 1. 搜索 open 的 doc-freshness issues
      let issues: Array<{ number: number; title: string; body: string; labels: string[] }>;
      try {
        const raw = execSync(
          'gh issue list --label doc-freshness --state open --json number,title,body,labels --limit 10',
          { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        issues = JSON.parse(raw);
      } catch (e) {
        logger.warn('[AuditorAgent] gh issue list failed (gh CLI not available?)', { error: String(e).slice(0, 200) });
        return;
      }

      if (issues.length === 0) {
        logger.info('[AuditorAgent] No open doc-freshness issues');
        return;
      }

      logger.info('[AuditorAgent] Processing doc-freshness issues', { count: issues.length });

      for (const issue of issues) {
        try {
          await this.processDocFreshnessIssue(issue, execSync);
        } catch (e) {
          logger.warn('[AuditorAgent] Failed to process doc-freshness issue', {
            issueNumber: issue.number,
            error: String(e).slice(0, 200),
          });
        }
      }
    } catch (e) {
      logger.warn('[AuditorAgent] handleDocFreshnessIssues failed', { error: String(e) });
    }
  }

  /**
   * 处理单个 doc-freshness issue:
   * 1. 解析 issue body 中的差异报告
   * 2. numeric/status → 运行 ci-doc-freshness-check 重新检测 → 如果仍有差异，自动修复文档
   * 3. narrative → 添加分析评论
   */
  private async processDocFreshnessIssue(
    issue: { number: number; title: string; body: string; labels: string[] },
    execSync: typeof import('child_process').execSync,
  ): Promise<void> {
    const repoDir = process.env.REPO_DIR || process.cwd();

    // 从 issue body 解析差异类型
    const body = issue.body || '';
    const hasNumeric = /\|\s*numeric\s*\|\s*([1-9]\d*)\s*\|/.test(body);
    const hasStatus = /\|\s*status\s*\|\s*([1-9]\d*)\s*\|/.test(body);
    const hasNarrative = /\|\s*narrative\s*\|\s*([1-9]\d*)\s*\|/.test(body);

    if (!hasNumeric && !hasStatus && !hasNarrative) {
      // 无法解析 — 添加提示评论并关闭
      try {
        execSync(
          `gh issue comment ${issue.number} --body "无法解析差异报告。手动检查文档新鲜度。"`,
          { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
        );
        execSync(`gh issue close ${issue.number}`, {
          cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
        });
      } catch { /* non-blocking */ }
      return;
    }

    // 重新运行检测确认差异仍然存在
    let reportJson: any;
    try {
      const reportRaw = execSync(
        `bash ${os.homedir()}/.studio/skills/always/doc-freshness/scripts/ci-doc-freshness-check.sh --project-path "${repoDir}" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      reportJson = JSON.parse(reportRaw);
    } catch {
      reportJson = null;
    }

    if (!reportJson || reportJson.summary?.totalDiffs === 0) {
      // 差异已消失 — 关闭 issue
      try {
        execSync(
          `gh issue comment ${issue.number} --body "重新检测：差异已消失（可能已被其他提交修复）。关闭此 issue。"`,
          { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
        );
        execSync(`gh issue close ${issue.number}`, {
          cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
        });
        logger.info('[AuditorAgent] Doc-freshness issue closed (diffs resolved)', { issueNumber: issue.number });
      } catch { /* non-blocking */ }
      return;
    }

    // 处理 numeric/status 差异 — 尝试自动修复
    const autoFixableDiffs = (reportJson.diffs || []).filter(
      (d: any) => d.type === 'numeric' || d.type === 'status',
    );
    const narrativeDiffs = (reportJson.diffs || []).filter(
      (d: any) => d.type === 'narrative',
    );

    let autoFixSummary = '';

    if (autoFixableDiffs.length > 0) {
      try {
        const fixResult = await this.autoFixDocDiffs(autoFixableDiffs, repoDir);
        autoFixSummary = fixResult;

        if (fixResult) {
          // 创建 PR
          const date = new Date().toISOString().slice(0, 10);
          const branchName = `doc-freshness/auto-fix/${date}`;

          try {
            execSync(
              `gh pr create --title "[doc-freshness] 自动修复 ${date}" --body "${fixResult}" --label doc-freshness`,
              { cwd: repoDir, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' },
            );
            autoFixSummary += '\n\nPR 已创建。';
          } catch (e) {
            logger.warn('[AuditorAgent] PR creation failed', { error: String(e).slice(0, 200) });
            autoFixSummary += '\n\nPR 创建失败，需手动提交修复。';
          }
        }
      } catch (e) {
        logger.warn('[AuditorAgent] Auto-fix failed', { error: String(e).slice(0, 200) });
        autoFixSummary = '自动修复失败，需手动处理。';
      }
    }

    // 构建评论
    const commentParts: string[] = ['## Auditor 自动处理报告', ''];

    if (autoFixableDiffs.length > 0) {
      commentParts.push('### Numeric/Status 差异（自动修复）');
      commentParts.push(autoFixSummary || '无修复摘要');
      commentParts.push('');
    }

    if (narrativeDiffs.length > 0) {
      commentParts.push('### Narrative 差异（需人工审查）');
      for (const d of narrativeDiffs) {
        commentParts.push(`- **${d.doc}** (L${d.line || '?'}): ${d.claim}`);
        commentParts.push(`  - 代码实际值: \`${d.actual || 'N/A'}\``);
      }
      commentParts.push('');
      commentParts.push('叙述性差异需要人工判断是否需要更新文档措辞。请审查后手动修复或关闭此 issue。');
    }

    // 发布评论
    try {
      const commentBody = commentParts.join('\n').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      execSync(
        `gh issue comment ${issue.number} --body "$(echo -e '${commentBody}')"`,
        { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
      );
    } catch (e) {
      logger.warn('[AuditorAgent] Failed to comment on issue', {
        issueNumber: issue.number,
        error: String(e).slice(0, 200),
      });
    }

    // 如果只有 narrative 差异且无 auto-fix，保持 issue open
    // 如果 auto-fix 成功且无 narrative，关闭 issue
    if (autoFixableDiffs.length > 0 && narrativeDiffs.length === 0 && autoFixSummary) {
      try {
        execSync(`gh issue close ${issue.number}`, {
          cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
        });
        logger.info('[AuditorAgent] Doc-freshness issue closed (auto-fixed)', { issueNumber: issue.number });
      } catch { /* non-blocking */ }
    }

    logger.info('[AuditorAgent] Doc-freshness issue processed', {
      issueNumber: issue.number,
      autoFixable: autoFixableDiffs.length,
      narrative: narrativeDiffs.length,
    });
  }

  /**
   * 自动修复 numeric/status 类型的文档差异
   * 返回修复摘要，空字符串表示无修复
   */
  private async autoFixDocDiffs(diffs: Array<{
    doc: string; type: string; claim: string; expected: string; actual: string; line?: number;
  }>, repoDir: string): Promise<string> {
    const fixed: string[] = [];
    const failed: string[] = [];

    for (const diff of diffs) {
      try {
        if (!diff.doc || !diff.actual || !diff.expected) {
          failed.push(`${diff.doc}: 缺少 expected/actual 值`);
          continue;
        }

        // 读取文档
        const fullPath = path.isAbsolute(diff.doc)
          ? diff.doc
          : path.join(repoDir, diff.doc);

        if (!fs.existsSync(fullPath)) {
          failed.push(`${diff.doc}: 文件不存在`);
          continue;
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        // 定位目标行: 优先用 line，否则搜索 actual 值
        let targetLine = -1;
        if (diff.line && diff.line > 0 && diff.line <= lines.length) {
          targetLine = diff.line - 1; // 0-indexed
        } else {
          // 搜索包含 actual 值的行
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(diff.actual)) {
              targetLine = i;
              break;
            }
          }
        }

        if (targetLine < 0) {
          failed.push(`${diff.doc}: 无法定位 "${diff.actual}"`);
          continue;
        }

        // 替换 actual → expected
        lines[targetLine] = lines[targetLine].replace(diff.actual, diff.expected);
        fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');
        fixed.push(`${diff.doc} L${targetLine + 1}: "${diff.actual}" → "${diff.expected}"`);
      } catch (e) {
        failed.push(`${diff.doc}: ${String(e).slice(0, 100)}`);
      }
    }

    if (fixed.length === 0) return '';

    // Git commit
    try {
      const { execSync } = await import('child_process');
      const date = new Date().toISOString().slice(0, 10);
      const branchName = `doc-freshness/auto-fix/${date}`;

      execSync(`git checkout -b "${branchName}"`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe' });
      execSync(`git add -A`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe' });
      execSync(`git commit -m "fix(doc-freshness): auto-fix ${fixed.length} numeric/status diffs"`, {
        cwd: repoDir, timeout: 10_000, stdio: 'pipe',
      });
    } catch (e) {
      logger.warn('[AuditorAgent] Git commit for doc-freshness fix failed', { error: String(e).slice(0, 200) });
    }

    const parts = [`已自动修复 ${fixed.length} 处差异:`];
    for (const f of fixed) parts.push(`- ${f}`);
    if (failed.length > 0) {
      parts.push('', `${failed.length} 处修复失败:`);
      for (const f of failed) parts.push(`- ${f}`);
    }
    return parts.join('\n');
  }

  // ── Post to Channel ──

  private async postToSystemChannel(content: string): Promise<void> {
    try {
      const channel = (await this.fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
      if (!channel) {
        logger.warn('[AuditorAgent] System channel not found');
        return;
      }

      const { channelMessageService } = await import('../channels/channel-message.service.js');
      await channelMessageService.createAgentMessage(
        channel.id,
        'Auditor',
        content,
        { meta: { cardType: 'audit-report', source: 'auditor-agent' } },
      );
    } catch (e) {
      logger.warn('[AuditorAgent] Failed to post to system channel', { error: String(e) });
    }
  }

  // ── B8: OKR 驱动闭环 ──

  /**
   * 提案预检 — 轻量可行性校验
   */
  async preCheckProposal(proposal: { suggestedFix: string; confidence: number }): Promise<{
    status: 'pass' | 'warning' | 'blocked';
    reasons: string[];
  }> {
    const reasons: string[] = [];

    // 1. Confidence 阈值
    if (proposal.confidence < 0.5) {
      reasons.push('confidence 低于 0.5，分析结果可信度不足');
    }

    // 2. RKB 历史: 类似提案之前失败过?
    try {
      let similar: any = null;
      try {
        const RES_DIR = path.join(os.homedir(), '.studio', 'data', 'resolutions');
        let allRes: any[] = [];
        try {
          const entries = await fs.promises.readdir(RES_DIR, { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.json')) {
              const data = await fileStore.readJson<any>(path.join(RES_DIR, e.name));
              if (data) allRes.push(data);
            }
          }
        } catch { /* no resolutions dir */ }
        similar = allRes.find((r: any) =>
          (r.status === 'pending' || r.status === 'canonical') &&
          r.fix && r.fix.includes(proposal.suggestedFix.substring(0, 50))
        ) || null;
      } catch { /* non-blocking */ }
      if (similar && similar.status === 'pending') {
        reasons.push(`类似方案 "${similar.title}" 仍在 pending 状态，建议等待验证结果`);
      }
    } catch { /* non-blocking */ }

    // 3. 检查重复提案
    try {
      const allWuSnapshots = await this.fileStore.getIndex();
      const cutoff = new Date(Date.now() - 14 * 86400000);
      const recentWorkUnits = allWuSnapshots.filter(s => {
        if (s.type !== 'okr_proposal') return false;
        if (new Date(s.createdAt).getTime() < cutoff.getTime()) return false;
        if (!s.scope || !s.scope.includes(proposal.suggestedFix.substring(0, 30))) return false;
        return true;
      });
      if (recentWorkUnits.length > 0) {
        reasons.push(`最近 14 天内已有 ${recentWorkUnits.length} 个相似 WorkUnit，建议检查是否需要重新提案`);
      }
    } catch { /* non-blocking */ }

    let status: 'pass' | 'warning' | 'blocked' = 'pass';
    if (reasons.length === 0) {
      status = 'pass';
    } else if (proposal.confidence < 0.3 || reasons.length >= 2) {
      status = 'blocked';
    } else {
      status = 'warning';
    }

    return { status, reasons };
  }
}

export const auditorAgent = new AuditorAgent();
