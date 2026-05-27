/**
 * Auditor Agent — 跨任务审计 + 周期洞察
 *
 * 2026-05-09: 初始实现。每日扫描审计事件和执行结果，产出入门级洞察。
 * 远期 B4-001：系统级 GC + 模型 tier 成功率矩阵 + 约束效果评估。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { prisma } from '@dommaker/studio-prisma';
import { logger, modelGateway } from '@dommaker/studio-shared';
import { knowledgeBus } from '../knowledge/knowledge-bus.service.js';

const AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
const SYSTEM_CHANNEL_NAME = '#系统';

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

      // P2.5b: Load historical audit context
      try {
        const ctx = knowledgeBus.getRecentContext('auditor', 5);
        if (ctx) logger.info('[AuditorAgent] Historical audit context loaded');
      } catch { /* non-blocking */ }

      // 1. 过去 24h 的执行统计（含 agentType 用于 3D 分析）
      const recentExecs = await prisma.goalExecution.findMany({
        where: { completedAt: { gte: yesterday } },
        select: { status: true, error: true, agentType: true, input: true },
      });
      const total = recentExecs.length;
      const failed = recentExecs.filter(e => e.status === 'failed').length;
      const successRate = total > 0 ? Math.round((1 - failed / total) * 100) : 100;

      // 2. 失败归类（全局 + 按 agent-type）
      const errorCounts = new Map<string, number>();
      const errorByAgentType = new Map<string, Map<string, number>>();
      for (const e of recentExecs) {
        if (e.status !== 'failed' || !e.error) continue;
        const errorType = this.classifyError(e.error as string);
        errorCounts.set(errorType, (errorCounts.get(errorType) || 0) + 1);

        const agentType = e.agentType || 'unknown';
        if (!errorByAgentType.has(agentType)) {
          errorByAgentType.set(agentType, new Map());
        }
        const perType = errorByAgentType.get(agentType)!;
        perType.set(errorType, (perType.get(errorType) || 0) + 1);
      }

      // 3. 最近 24h 的审计事件统计
      const auditCount = await prisma.decisionAudit.count({
        where: { createdAt: { gte: yesterday } },
      });

      // 4. Agent-type × tier 3D 交叉分析
      const agentTypeStats = new Map<string, { total: number; failed: number }>();
      const tierStats = new Map<string, { total: number; failed: number }>();

      for (const e of recentExecs) {
        const agentType = e.agentType || 'unknown';
        const ag = agentTypeStats.get(agentType) || { total: 0, failed: 0 };
        ag.total++;
        if (e.status === 'failed') ag.failed++;
        agentTypeStats.set(agentType, ag);

        // Extract modelTier from input JSON or default to 'standard'
        let tier = 'standard';
        try {
          if (e.input) {
            const parsed = typeof e.input === 'string' ? JSON.parse(e.input) : e.input;
            tier = (parsed as any)?.modelTier || 'standard';
          }
        } catch { /* use default */ }
        const tr = tierStats.get(tier) || { total: 0, failed: 0 };
        tr.total++;
        if (e.status === 'failed') tr.failed++;
        tierStats.set(tier, tr);
      }

      // 5. Goal 状态分布
      const goalStats = await prisma.goal.groupBy({
        by: ['status'],
        where: { updatedAt: { gte: yesterday } },
        _count: true,
      });

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
        '### Goal 状态',
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
      await this.generateEvalCases(recentExecs);

      // RKB: 对新 error pattern 自动创建 pending Resolution
      await this.autoCreateResolutions(recentExecs);

      // 开发会话行为趋势 (session:summary → behavioral insights)
      const sessionTrends = await this.analyzeSessionTrends(yesterday);
      if (sessionTrends.length > 0) {
        summary.push('', '### 开发会话行为趋势', ...sessionTrends);
      }

      // Record audit findings to KnowledgeBus
      knowledgeBus.recordPattern({
        source: 'auditor',
        type: 'trend',
        title: `[Auditor] Daily audit ${now.toISOString().slice(0, 10)}: ${total} execs, ${successRate}% success`,
        content: summary.filter(l => l.startsWith('-')).join('\n'),
        severity: successRate < 80 ? 'warning' : 'info',
        timestamp: Date.now(),
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
        if (e.status !== 'failed' || !e.error) continue;
        const errorClass = this.classifyError(e.error);
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

    // Overall successRate < 50% → pipeline_health_degraded
    if (total >= 5 && overallSuccessRate < 50) {
      try {
        const { triageAgent } = await import('./triage-agent.service.js');
        triageAgent.handleAlert({
          type: 'pipeline_health_degraded',
          severity: 'critical',
          message: `Pipeline success rate ${overallSuccessRate}% (${failed}/${total} failed) below 50% threshold`,
          details: {
            overallSuccessRate,
            total,
            failed,
          },
        }).catch(err => {
          logger.error('[AuditorAgent] Triage escalation failed (pipeline_health)', {
            error: String(err),
          });
        });
      } catch (err) {
        logger.warn('[AuditorAgent] Failed to import triageAgent for pipeline_health_degraded', { error: String(err) });
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
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
      const stats = knowledgeBus.getStats();
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

      // Circuit 5: Pipeline cache efficiency — from PipelineRun.sessionId entries
      try {
        const recentRuns = await prisma.pipelineRun.findMany({
          where: {
            sessionId: { not: null },
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          select: { phase: true, model: true, cacheHitTokens: true, inputTokens: true },
          orderBy: { createdAt: 'desc' },
          take: 30,
        });
        if (recentRuns.length > 0) {
          const byPhase = new Map<string, { total: number; ratio: number; model: string }>();
          for (const r of recentRuns) {
            const key = r.phase;
            const existing = byPhase.get(key);
            if (!existing || r.inputTokens > 0) {
              const ratio = r.inputTokens > 0 ? r.cacheHitTokens / r.inputTokens : 0;
              byPhase.set(key, { total: (existing?.total || 0) + 1, ratio: existing ? Math.max(existing.ratio, ratio) : ratio, model: r.model });
            }
          }
          for (const [phase, s] of byPhase) {
            if (s.ratio < 5) {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `${phase} 缓存比仅 ${s.ratio.toFixed(1)}x (${s.total} sessions, ${s.model}) — 检查 shared prefix 是否生效`,
              });
            }
          }
        }
      } catch { /* non-blocking */ }

      // Circuit 6: CONTEXT.md 覆盖率 — 关键目录缺索引则 Analysist 每次都重探索
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
        const okrs = await prisma.oKR.findMany({ where: { status: 'active' } });
        for (const okr of okrs) {
          const krs: any[] = typeof okr.keyResults === 'string' ? JSON.parse(okr.keyResults) : okr.keyResults;
          for (const kr of krs) {
            if (!kr.metricType || !kr.target || kr.target <= 0) continue;

            const ds = okrService ? 'ok' : 'empty'; // service exists
            if (!ds) continue;

            // Query KR history for trend
            const history = await prisma.kRHistory.findMany({
              where: { okrId: okr.id, krId: kr.id },
              orderBy: { timestamp: 'desc' },
              take: 7,
            });

            const latest = history[0];
            if (!latest) continue;

            if (latest.status === 'no_data') {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.title}" KR "${kr.title}": 数据暂不可用 (metricType: ${kr.metricType})`,
              });
              continue;
            }

            if (latest.status === 'stale') {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.title}" KR "${kr.title}": 数据已过期`,
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
                detail: `OKR "${okr.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，趋势${trend < 0 ? '恶化中' : '未改善'}。建议触发深度根因分析`,
              });
            } else if (ratio < 0.8) {
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.title}" KR "${kr.title}": 达成率 ${Math.round(ratio * 100)}% (${latest.value}/${kr.target}${kr.unit || ''})，低于目标`,
              });
            }

            // 🆕 B8 Phase 1.5: 重校准 — baseline 已超 target 时建议上调
            if (ratio > 1.05) {
              const suggested = Math.ceil(latest.value * 1.02);
              suggestions.push({
                type: 'circuit_fix',
                risk: 'low',
                agentType: 'auditor',
                detail: `OKR "${okr.title}" KR "${kr.title}": 当前实际 ${latest.value}${kr.unit || ''} 已超过目标 ${kr.target}${kr.unit || ''} (${Math.round(ratio * 100)}%)。建议上调 target 至 >= ${suggested}${kr.unit || ''}`,
              });
            }
          }
        }
      // Circuit 8: Memory→KnowledgeStore sync health
      try {
        const memoryDir = path.join(os.homedir(), '.claude', 'projects', '-root-projects', 'memory');
        const knowledgeDir = path.join(process.env.REPO_DIR || process.cwd(), '.harness', 'knowledge');
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
      // Query skills with sufficient usage for weight/status analysis
      const skills = await prisma.skill.findMany({
        where: { usageCount: { gte: 5 } },
      });

      // Detection rule 1: skill_weight — low successRate + sufficient usage
      for (const skill of skills) {
        if (skill.successRate < 0.3) {
          suggestions.push({
            type: 'skill_weight',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率 ${(skill.successRate * 100).toFixed(0)}% < 30%，建议调整权重`,
            data: { successRate: skill.successRate, usageCount: skill.usageCount },
          });
        }

        // Detection rule 2: skill_status — high successRate + still draft
        if (skill.successRate >= 0.8 && skill.status === 'draft') {
          suggestions.push({
            type: 'skill_status',
            risk: 'low',
            skillId: skill.id,
            skillName: skill.name,
            detail: `Skill "${skill.name}" 成功率达 ${(skill.successRate * 100).toFixed(0)}%，建议发布`,
            data: { successRate: skill.successRate, currentStatus: skill.status },
          });
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
          await prisma.skill.update({
            where: { id: s.skillId },
            data: { successRate: s.data?.successRate as number },
          });
          applied.push(`Skill "${s.skillName}" 成功率权重已更新`);
          logger.info('[AuditorAgent] Auto-applied skill_weight', { skillId: s.skillId, skillName: s.skillName });
        } else if (s.type === 'skill_status' && s.skillId) {
          await prisma.skill.update({
            where: { id: s.skillId },
            data: { status: 'published' },
          });
          applied.push(`Skill "${s.skillName}" 已自动发布`);
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
      const channel = await prisma.channel.findUnique({ where: { name: SYSTEM_CHANNEL_NAME } });
      if (!channel) {
        logger.warn('[AuditorAgent] System channel not found for suggestion cards');
        return;
      }

      const { channelMessageService } = await import('../channels/channel-message.service.js');
      const { NotificationService } = await import('@dommaker/studio-notification');

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
        const notifService = new NotificationService(prisma as any);
        const users = await prisma.role.findMany({
          where: { type: 'user' },
          select: { id: true },
          take: 10,
        });
        for (const user of users) {
          await notifService.create({
            userId: user.id,
            type: 'auditor_suggestion',
            title: `审计建议 (${suggestions.length} 项)`,
            content: suggestions.map(s => s.detail).join(' | '),
            link: `/channels/${channel.id}`,
          });
        }
        logger.info('[AuditorAgent] Push notifications sent', { users: users.length, suggestions: suggestions.length });
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

      await prisma.decisionAudit.create({
        data: {
          entityType: 'model_tier',
          entityId: `daily-${new Date().toISOString().slice(0, 10)}`,
          eventType: 'tier_success_rate',
          summary: JSON.stringify(stats),
        },
      });

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
      .filter(e => e.status === 'failed' && e.error)
      .map(e => ({
        goalId: (e as any).goalId || 'unknown',
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

  // ── Post to Channel ──

  private async postToSystemChannel(content: string): Promise<void> {
    try {
      const channel = await prisma.channel.findUnique({ where: { name: SYSTEM_CHANNEL_NAME } });
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
   * 根因诊断 + 优化提案 (每周/按需触发)
   */
  async diagnoseRootCause(okrId: string, krTitle: string, trigger: 'weekly' | 'critical' = 'weekly'): Promise<{
    rootCause: string;
    suggestedFix: string;
    expectedImprovement: string;
    confidence: number;  // 0-1
  } | null> {
    try {
      const okr = await prisma.oKR.findUnique({ where: { id: okrId } });
      if (!okr) return null;
      const krs: any[] = typeof okr.keyResults === 'string' ? JSON.parse(okr.keyResults) : okr.keyResults;
      const kr = krs.find((k: any) => k.title === krTitle);
      if (!kr || !kr.metricType) return null;

      // 聚合信号
      const signals = await this.aggregateDiagnosticSignals();

      // 构建 LLM 根因分析 prompt
      const prompt = [
        `你是系统优化分析师。管线 OKR KR "${krTitle}" 当前值 ${kr.current || '?'}，目标值 ${kr.target}${kr.unit || ''}。`,
        kr.current && kr.target ? `达成率: ${Math.round(kr.current / kr.target * 100)}%。` : '',
        '',
        '### 近期数据',
        ...signals,
        '',
        '### 要求',
        '请分析：',
        '1. 核心瓶颈是什么？（引用数据来源）',
        '2. 建议的优化方案（具体到代码层面，不空泛）',
        '3. 预期改善效果（量化估计）',
        '4. 置信度 (high/medium/low)',
        '',
        '返回 JSON: {"rootCause": "...", "suggestedFix": "...", "expectedImprovement": "...", "confidence": "high|medium|low"}',
      ].filter(Boolean).join('\n');

      const result = await modelGateway.promptJson<{
        rootCause: string;
        suggestedFix: string;
        expectedImprovement: string;
        confidence: string;
      }>(prompt, '你是系统优化分析师。基于数据找瓶颈，给具体优化方案。');

      const confidenceMap: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.3 };
      return {
        rootCause: result.rootCause,
        suggestedFix: result.suggestedFix,
        expectedImprovement: result.expectedImprovement,
        confidence: confidenceMap[result.confidence] || 0.5,
      };
    } catch (e) {
      logger.warn('[AuditorAgent] diagnoseRootCause failed', { error: String(e) });
      return null;
    }
  }

  /**
   * 聚合诊断信号
   */
  private async aggregateDiagnosticSignals(): Promise<string[]> {
    const signals: string[] = [];
    const since = new Date(Date.now() - 7 * 86400000);

    try {
      // Phase breakdown
      const phaseStats = await prisma.pipelineRun.groupBy({
        by: ['phase'],
        where: { createdAt: { gte: since }, phase: { not: 'full' }, inputTokens: { gt: 0 } },
        _avg: { durationMs: true },
        _count: true,
      });
      if (phaseStats.length > 0) {
        const total = phaseStats.reduce((s, p) => s + (p._avg.durationMs || 0), 0);
        signals.push(`- Phase 耗时分布: ${phaseStats.map(p => `${p.phase} ${Math.round((p._avg.durationMs || 0) / 1000 / 60)}min (${total > 0 ? Math.round((p._avg.durationMs || 0) / total * 100) : 0}%)`).join(', ')}`);
      }
    } catch { /* non-blocking */ }

    try {
      // Session count
      const multiSession = await prisma.pipelineRun.count({
        where: { createdAt: { gte: since }, phase: 'executor', sessionId: { not: null } },
      });
      signals.push(`- Executor 执行次数: ${multiSession}`);
    } catch { /* non-blocking */ }

    try {
      // KnowledgeBus patterns via getStats
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
      const stats = knowledgeBus.getStats();
      if (stats.total && stats.total > 0) {
        const entries = Object.entries(stats).filter(([k]) => k !== 'total')
          .map(([k, v]) => `${k}:${v}`).join(', ');
        signals.push(`- KnowledgeBus 统计: ${entries || 'empty'} (total: ${stats.total})`);
      }
    } catch { /* non-blocking */ }

    try {
      // RKB patterns
      const resolutions = await prisma.resolution.count({ where: { status: 'canonical' } });
      signals.push(`- RKB 已知解法: ${resolutions} 条 canonical`);
    } catch { /* non-blocking */ }

    return signals;
  }

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
      const similar = await prisma.resolution.findFirst({
        where: {
          status: { in: ['pending', 'canonical'] },
          fix: { contains: proposal.suggestedFix.substring(0, 50) },
        },
      });
      if (similar && similar.status === 'pending') {
        reasons.push(`类似方案 "${similar.title}" 仍在 pending 状态，建议等待验证结果`);
      }
    } catch { /* non-blocking */ }

    // 3. 检查重复提案
    try {
      const recentGoals = await prisma.goal.findMany({
        where: {
          title: { contains: proposal.suggestedFix.substring(0, 30) },
          createdAt: { gte: new Date(Date.now() - 14 * 86400000) },
        },
      });
      if (recentGoals.length > 0) {
        reasons.push(`最近 14 天内已有 ${recentGoals.length} 个相似 Goal，建议检查是否需要重新提案`);
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
