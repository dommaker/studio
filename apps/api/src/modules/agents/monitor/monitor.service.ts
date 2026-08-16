/**
 * Monitor Service - 健康监控 + NA Step 7 渐进告警
 *
 * 每 5 分钟轮询：
 *   - 失败趋势（#181 起改读统一事件流）
 *   - 进度停滞（.progress.json completedSteps 无变化）
 *   - 池滞留 / in_review 滞留（#181）
 *   - 会话计数超阈值
 *   - 总执行时间超阈值
 *   - blocked 24h 自动放弃
 *
 * 结构（T3 拆分：探测/告警/报告分离，零行为变更；本文件为门面，保留聚合逻辑）：
 *   - monitor-probes.ts        任务/WorkUnit 级探测（失败趋势/停滞/超时/工具模式）
 *   - monitor-system-probes.ts 系统/知识级探测与自修复（系统健康/worktree GC/知识循环）
 *   - monitor-alerts.ts        告警分发/Triage 升级/事件写入
 *   - monitor-reports.ts       轨迹评估/每日洞察/交互模式观察
 *   - monitor-lifecycle.ts     G31 知识沉淀闸门 + 数据 TTL 清理
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import type { MonitorAlert } from '../types.js';
import * as probes from './monitor-probes.js';
import * as systemProbes from './monitor-system-probes.js';
import * as alerting from './monitor-alerts.js';
import * as reports from './monitor-reports.js';
import * as lifecycle from './monitor-lifecycle.js';
const CHECK_INTERVAL = 5 * 60_000; // 5 min

export class MonitorService {
  private interval: NodeJS.Timeout | null = null;
  private circuitCheckInterval: NodeJS.Timeout | null = null;
  private fileStore: FileStore;
  // 实例级周期状态（传入各子模块，保持拆分前的 per-instance 语义）
  private readonly knowledgeCycleState: systemProbes.KnowledgeCycleState = { lastDecayRun: 0, lastUserModelRun: 0 };
  private readonly reportState: reports.ReportState = { lastDailyReflectionTs: 0 };
  private readonly lifecycleState: lifecycle.LifecycleState = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check().catch(e => {
      logger.error('[MonitorService] Check failed', { error: String(e) });
    }), CHECK_INTERVAL);

    // Circuit self-check at startup — detect + auto-repair + write meta-knowledge
    this.runCircuitCheckAndRepair();

    // Periodic circuit check (hourly)
    this.circuitCheckInterval = setInterval(() => this.runCircuitCheckAndRepair(), 60 * 60 * 1000);

    logger.info('[MonitorService] Started', { checkInterval: CHECK_INTERVAL });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.circuitCheckInterval) {
      clearInterval(this.circuitCheckInterval);
      this.circuitCheckInterval = null;
    }
    logger.info('[MonitorService] Stopped');
  }

  private async check(): Promise<void> {
    const alerts: MonitorAlert[] = [];

    alerts.push(...await this.checkFailureTrend());
    alerts.push(...await this.checkProgressStagnation());
    alerts.push(...await this.checkTotalExecutionTime());
    alerts.push(...await this.checkPoolStagnation());
    alerts.push(...await this.checkReviewStagnation());
    alerts.push(...await this.checkToolPatterns());
    await this.evaluateTrajectory();  // G4
    await this.autoAbandonStaleBlocked();
    await this.systemTriageCheck();
    await this.gcStaleWorktrees();
    await this.checkKnowledgeHealth();
    alerts.push(...await this.checkSessionFileHealth());
    // DailyReflection: 每天 23:50 聚合一次每日洞察
    await this.dailyReflection();

    // G31: Data lifecycle TTL — 每天 23:55 清理过期数据
    await this.dataLifecycle();

    // Log all alerts + emit warning/critical to studio events file
    alerting.dispatchMonitorAlerts(alerts);

    // Phase 1 (FL-037): Escalate critical execution-level alerts to Triage
    this.escalateToTriage(alerts);

    // H3: Write patterns to KnowledgeBus (Monitor→Auditor/KK→Analyst)
    alerting.recordAlertPatterns(alerts);
  }

  // ── 探测（monitor-probes / monitor-system-probes）──

  private async checkFailureTrend(): Promise<MonitorAlert[]> {
    return probes.checkFailureTrend(this.fileStore);
  }

  private async checkProgressStagnation(): Promise<MonitorAlert[]> {
    return probes.checkProgressStagnation(this.fileStore);
  }

  private async checkTotalExecutionTime(): Promise<MonitorAlert[]> {
    return probes.checkTotalExecutionTime(this.fileStore);
  }

  private async checkPoolStagnation(): Promise<MonitorAlert[]> {
    return probes.checkPoolStagnation(this.fileStore);
  }

  private async checkReviewStagnation(): Promise<MonitorAlert[]> {
    return probes.checkReviewStagnation(this.fileStore);
  }

  private async autoAbandonStaleBlocked(): Promise<void> {
    return probes.autoAbandonStaleBlocked(this.fileStore);
  }

  private async gcStaleWorktrees(): Promise<void> {
    return systemProbes.gcStaleWorktrees();
  }

  private async checkSessionFileHealth(): Promise<MonitorAlert[]> {
    return probes.checkSessionFileHealth();
  }

  private async checkToolPatterns(): Promise<MonitorAlert[]> {
    return probes.checkToolPatterns();
  }

  private async runCircuitCheckAndRepair(): Promise<void> {
    return systemProbes.runCircuitCheckAndRepair();
  }

  private async checkKnowledgeHealth(): Promise<void> {
    return systemProbes.checkKnowledgeHealth(this.knowledgeCycleState);
  }

  private async systemTriageCheck(): Promise<void> {
    return systemProbes.systemTriageCheck();
  }

  // ── 告警（monitor-alerts）──

  /**
   * FL-037: Map MonitorAlert.source → TriageIncidentInput.type
   * Only critical alerts are escalated. Fire-and-forget, does not block check loop.
   */
  private escalateToTriage(alerts: MonitorAlert[]): void {
    return alerting.escalateToTriage(alerts);
  }

  // ── 报告（monitor-reports）──

  /** G4: Trajectory Eval — 结构化轨迹评估 */
  async evaluateTrajectory(): Promise<void> {
    return reports.evaluateTrajectory(this.fileStore);
  }

  private async dailyReflection(): Promise<void> {
    return reports.dailyReflection(this.fileStore, this.reportState);
  }

  // ── 数据生命周期（monitor-lifecycle）──

  private async dataLifecycle(): Promise<void> {
    return lifecycle.dataLifecycle(this.fileStore, this.lifecycleState);
  }
}

export const monitorService = new MonitorService();
