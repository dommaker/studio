/**
 * Auditor Service — 跨任务审计 + 周期洞察
 *
 * 2026-05-09: 初始实现。每日扫描审计事件和执行结果，产出入门级洞察。
 * 远期 B4-001：系统级 GC + 模型 tier 成功率矩阵 + 约束效果评估。
 *
 * 结构（T3 拆分：审计规则/执行/报告分离，零行为变更；本文件为门面，保留聚合逻辑）：
 *   - auditor-rules.ts         审计规则（错误归类/技能与 agent-type 建议/用户模型质量/知识电路健康）
 *   - auditor-execution.ts     建议执行（低风险自动应用/确认卡片/Resolution 创建/Triage 升级/eval case）
 *   - auditor-reports.ts       洞察与报告输出（会话行为趋势/7 日趋势/tier 成功率/#系统 推送）
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { knowledgeService } from '../knowledge/knowledge-service.js';
import * as rules from './auditor-rules.js';
import type { Suggestion } from './auditor-rules.js';
import * as execution from './auditor-execution.js';
import * as reports from './auditor-reports.js';

const AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily

export class AuditorService {
  private interval: NodeJS.Timeout | null = null;
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.dailyAudit(), AUDIT_INTERVAL_MS);
    logger.info('[AuditorService] Started', { interval: '24h' });
    // 首次启动 5 分钟后跑一次
    setTimeout(() => this.dailyAudit(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    logger.info('[AuditorService] Stopped');
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

      // 4. Agent-type 交叉分析
      const agentTypeStats = new Map<string, { total: number; failed: number }>();

      for (const e of recentExecs) {
        const eMeta = e.metadata ? JSON.parse(e.metadata) : {};
        const agentType = eMeta.agentType || 'unknown';
        const ag = agentTypeStats.get(agentType) || { total: 0, failed: 0 };
        ag.total++;
        if (e.status === 'closed') ag.failed++;
        agentTypeStats.set(agentType, ag);
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

      // 新增: 用户模型 + 电路健康摘要
      if (modelSuggestions.length > 0) {
        summary.push('', '### 用户模型质量', ...modelSuggestions.map(s => `- ${s.risk === 'high' ? '⚠️' : '📊'} ${s.detail}`));
      }
      if (circuitSuggestions.length > 0) {
        summary.push('', '### 知识电路健康', ...circuitSuggestions.map(s => `- ${s.risk === 'high' ? '🔴' : '🟡'} ${s.detail}`));
      }

      // 开发会话行为趋势 (session:summary → behavioral insights)
      const sessionTrends = await this.analyzeSessionTrends(yesterday);
      if (sessionTrends.length > 0) {
        summary.push('', '### 开发会话行为趋势', ...sessionTrends);
      }

      const finalContent = summary.join('\n');

      // 8. 推送到 #系统 channel
      await this.postToSystemChannel(finalContent);

      // 8. Escalate anomalies to Triage (Phase 3)
      await this.escalateToTriage(agentTypeStats, successRate, total, failed);

      // 9. Better-Harness: 失败 → eval case 生成
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

      // Record audit findings to KnowledgeService
      knowledgeService.recordPattern({
        type: 'trend',
        title: `[Auditor] Daily audit ${now.toISOString().slice(0, 10)}: ${total} execs, ${successRate}% success`,
        content: summary.filter(l => l.startsWith('-')).join('\n'),
        tags: ['auditor'],
      }).catch(() => { /* non-blocking */ });

      logger.info('[AuditorService] Daily audit completed', { total, failed, successRate });
    } catch (e) {
      logger.error('[AuditorService] Daily audit failed', { error: String(e) });
    }
  }

  // ── 审计规则（auditor-rules）──

  private classifyError(errorMsg: string): string {
    return rules.classifyError(errorMsg);
  }

  private async analyzeUserModel(): Promise<Suggestion[]> {
    return rules.analyzeUserModel();
  }

  private async analyzeCircuitHealth(): Promise<Suggestion[]> {
    return rules.analyzeCircuitHealth(this.fileStore);
  }

  private async generateSuggestions(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    errorByAgentType: Map<string, Map<string, number>>,
  ): Promise<Suggestion[]> {
    return rules.generateSuggestions(this.fileStore, agentTypeStats, errorByAgentType);
  }

  // ── 建议执行（auditor-execution）──

  private async applyLowRiskSuggestions(suggestions: Suggestion[]): Promise<string[]> {
    return execution.applyLowRiskSuggestions(suggestions);
  }

  private async pushConfirmationCards(suggestions: Suggestion[]): Promise<void> {
    return execution.pushConfirmationCards(this.fileStore, suggestions);
  }

  private async autoCreateResolutions(
    recentExecs: Array<{ status: string; error: string | null; agentType: string | null }>,
  ): Promise<void> {
    return execution.autoCreateResolutions(recentExecs);
  }

  private async escalateToTriage(
    agentTypeStats: Map<string, { total: number; failed: number }>,
    overallSuccessRate: number,
    total: number,
    failed: number,
  ): Promise<void> {
    return execution.escalateToTriage(agentTypeStats, overallSuccessRate, total, failed);
  }

  private async generateEvalCases(recentExecs: Array<{
    status: string;
    error: string | null;
    agentType: string | null;
    input: any;
    id?: string;
    goalId?: string;
  }>): Promise<void> {
    return execution.generateEvalCases(recentExecs);
  }

  // ── 洞察与报告（auditor-reports）──

  private async analyzeSessionTrends(since: Date): Promise<string[]> {
    return reports.analyzeSessionTrends(since);
  }

  private trackTrends(snapshot: {
    date: string; totalSessions: number; deepAnalysisCount: number;
    missingCaptureCount: number; sensitiveOpsSessions: number;
    highSensitiveOpsCount: number; avgTurns: number; maxTurnCount: number;
  }): string[] {
    return reports.trackTrends(snapshot);
  }

  private async postToSystemChannel(content: string): Promise<void> {
    return reports.postToSystemChannel(this.fileStore, content);
  }
}

export const auditorService = new AuditorService();
