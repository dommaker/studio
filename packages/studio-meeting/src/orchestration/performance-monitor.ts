/**
 * 性能监控器（业务层）
 *
 * 使用 harness 的 PerformanceCollector 和 PerformanceAnalyzer
 *
 * 功能：
 * 1. 关键操作耗时监控
 * 2. Token 使用统计
 * 3. 上下文大小统计
 * 4. 性能报告生成
 *
 * 监控点：
 * - extract: 提取共享上下文
 * - transform: 转换为角色上下文
 * - prune: Token 裁剪
 * - invokeSkillAgent: 调用 Skill Agent
 * - reportBack: 结果回传
 */

import {
  PerformanceCollector,
  PerformanceAnalyzer,
  type PerformanceTrace,
  type PerformanceSummary,
  type PerformanceAnomaly,
} from '@dommaker/harness';
import type { ContextSharer } from './context-sharer';

// ============================================
// 类型定义（业务层）
// ============================================

/**
 * 性能监控配置
 */
export interface PerformanceMonitorConfig {
  contextSharer?: ContextSharer;
  eventEmitter?: {
    emit(event: string, data: any): void;
  };
  thresholds?: PerformanceThresholds;
  logFile?: string;
}

/**
 * 性能阈值
 */
export interface PerformanceThresholds {
  extract?: number;  // 提取耗时阈值（ms）
  transform?: number; // 转换耗时阈值（ms）
  prune?: number;    // 裁剪耗时阈值（ms）
  invoke?: number;   // 调用耗时阈值（ms）
  invokeSkillAgent?: number; // Skill Agent 调用阈值（ms）
  reportBack?: number; // 回传耗时阈值（ms）
  total?: number;    // 总耗时阈值（ms）
}

/**
 * 默认阈值
 */
const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  extract: 500,
  transform: 300,
  prune: 200,
  invoke: 30000, // 30s
  invokeSkillAgent: 30000, // 30s（Skill Agent 调用较慢）
  reportBack: 200,
  total: 35000,
};

/**
 * Token 使用指标
 */
export interface TokenMetric {
  meetingId: string;
  taskId?: string;
  roleId?: string;
  contextTokens: number;
  executionTokens: number;
  totalTokens: number;
  budget: number;
  exceeded: boolean;
  timestamp: string;
}

/**
 * 上下文大小指标
 */
export interface ContextSizeMetric {
  meetingId: string;
  entriesCount: number;
  totalSize: number;
  entries: Record<string, number>;
  timestamp: string;
}

/**
 * 性能报告
 */
export interface PerformanceReport {
  meetingId: string;
  startTime: string;
  endTime: string;
  totalDuration: number;
  summaries: PerformanceSummary[];
  anomalies: PerformanceAnomaly[];
  tokenUsage: TokenMetric[];
  contextSizes: ContextSizeMetric[];
  reportText?: string;
}

// 重新导出 harness 的类型，方便使用
export type { PerformanceSummary as HarnessPerformanceSummary, PerformanceAnomaly } from '@dommaker/harness';

// ============================================
// PerformanceMonitor 类
// ============================================

/**
 * 性能监控器
 */
export class PerformanceMonitor {
  private collector: PerformanceCollector;
  private analyzer: PerformanceAnalyzer;
  private contextSharer?: ContextSharer;
  private eventEmitter?: { emit(event: string, data: any): void };
  private thresholds: PerformanceThresholds;
  private tokenMetrics: TokenMetric[] = [];
  private contextSizeMetrics: ContextSizeMetric[] = [];

  constructor(config: PerformanceMonitorConfig) {
    this.contextSharer = config.contextSharer;
    this.eventEmitter = config.eventEmitter;
    this.thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;

    // 初始化 harness 组件
    this.collector = new PerformanceCollector({
      logFile: config.logFile || '.harness/logs/performance.log',
    });

    this.analyzer = new PerformanceAnalyzer(this.collector, {
      summaryFile: '.harness/logs/performance-summary.json',
      thresholds: {
        avgDuration: DEFAULT_THRESHOLDS.total,
        exceededRate: 0.3,
        errorRate: 0.1,
      },
    });
  }

  /**
   * 记录操作耗时
   */
  async recordOperation(
    operation: string,
    duration: number,
    metadata?: Record<string, any>
  ): Promise<void> {
    const threshold = this.getThreshold(operation);
    const exceeded = threshold ? duration > threshold : false;

    // 使用 harness 的 Collector 记录
    if (exceeded) {
      this.collector.recordExceeded(operation, duration, threshold!, metadata);
    } else {
      this.collector.recordOk(operation, duration, metadata);
    }

    // 超阈值告警
    if (exceeded) {
      this.emit('performance.exceeded', {
        operation,
        duration,
        threshold,
        metadata,
      });
    }

    this.emit('performance.recorded', { operation, duration, exceeded });
  }

  /**
   * 记录 Token 使用
   */
  async recordTokenUsage(
    meetingId: string,
    contextTokens: number,
    executionTokens: number,
    budget: number,
    metadata?: { taskId?: string; roleId?: string }
  ): Promise<TokenMetric> {
    const totalTokens = contextTokens + executionTokens;
    const exceeded = totalTokens > budget;

    const metric: TokenMetric = {
      meetingId,
      taskId: metadata?.taskId,
      roleId: metadata?.roleId,
      contextTokens,
      executionTokens,
      totalTokens,
      budget,
      exceeded,
      timestamp: new Date().toISOString(),
    };

    this.tokenMetrics.push(metric);

    if (exceeded) {
      this.emit('performance.token_exceeded', {
        meetingId,
        totalTokens,
        budget,
      });
    }

    return metric;
  }

  /**
   * 记录上下文大小
   */
  async recordContextSize(
    meetingId: string
  ): Promise<ContextSizeMetric> {
    let summary = { entryCount: 0, totalSize: 0 };

    if (this.contextSharer) {
      summary = await this.contextSharer.getSummary();
    }

    const metric: ContextSizeMetric = {
      meetingId,
      entriesCount: summary.entryCount,
      totalSize: summary.totalSize,
      entries: {},
      timestamp: new Date().toISOString(),
    };

    this.contextSizeMetrics.push(metric);

    return metric;
  }

  /**
   * 开始计时
   */
  startTimer(): { end: () => number } {
    const start = Date.now();
    return {
      end: () => Date.now() - start,
    };
  }

  /**
   * 包装操作计时
   */
  async withTiming<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<{ result: T; duration: number }> {
    const timer = this.startTimer();
    const result = await fn();
    const duration = timer.end();
    await this.recordOperation(operation, duration, metadata);

    return { result, duration };
  }

  /**
   * 生成性能报告
   */
  async generateReport(meetingId?: string): Promise<PerformanceReport> {
    // 使用 harness 的 Analyzer 分析
    const summaries = this.analyzer.analyzeRecent(1);
    const anomalies = this.analyzer.detectAnomalies(summaries);

    // 过滤 Token 使用数据
    const tokenUsage = meetingId
      ? this.tokenMetrics.filter(t => t.meetingId === meetingId)
      : this.tokenMetrics;

    // 过滤上下文大小数据
    const contextSizes = meetingId
      ? this.contextSizeMetrics.filter(c => c.meetingId === meetingId)
      : this.contextSizeMetrics;

    // 计算总耗时
    const totalDuration = summaries.reduce((sum: number, s) => sum + s.avgDuration, 0);

    // 生成文本报告
    const reportText = this.analyzer.generateReport(summaries, anomalies);

    const report: PerformanceReport = {
      meetingId: meetingId || 'all',
      startTime: new Date(Date.now() - 3600000).toISOString(),
      endTime: new Date().toISOString(),
      totalDuration,
      summaries,
      anomalies,
      tokenUsage,
      contextSizes,
      reportText,
    };

    return report;
  }

  /**
   * 运行每小时汇总
   */
  runHourlySummary(): PerformanceSummary[] {
    return this.analyzer.runHourlySummary();
  }

  /**
   * 运行每日异常检测
   */
  runDailyAnomalyCheck(): PerformanceAnomaly[] {
    return this.analyzer.runDailyAnomalyCheck();
  }

  /**
   * 获取阈值
   */
  getThresholds(): PerformanceThresholds {
    return this.thresholds;
  }

  /**
   * 设置阈值
   */
  setThresholds(thresholds: Partial<PerformanceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * 获取阈值（按操作）
   */
  private getThreshold(operation: string): number | undefined {
    const key = operation as keyof PerformanceThresholds;
    return this.thresholds[key];
  }

  /**
   * 清除指标
   */
  clear(): void {
    this.tokenMetrics = [];
    this.contextSizeMetrics = [];
  }

  /**
   * 获取底层 Collector（高级用法）
   */
  getCollector(): PerformanceCollector {
    return this.collector;
  }

  /**
   * 获取底层 Analyzer（高级用法）
   */
  getAnalyzer(): PerformanceAnalyzer {
    return this.analyzer;
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event, data);
  }
}

/**
 * 创建性能监控器（便捷函数）
 */
export function createPerformanceMonitor(config: PerformanceMonitorConfig): PerformanceMonitor {
  return new PerformanceMonitor(config);
}
