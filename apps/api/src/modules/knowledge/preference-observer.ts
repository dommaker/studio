/**
 * PreferenceObserver (G-001) — 从 MCP traces + 路由反馈中推断用户偏好
 *
 * 增量 EMA 更新，不阻塞主流程。
 * 冷启动：无历史数据时 confidence=0.3，积累 50+ 交互后提升到 0.7+
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

const EVENTS_DIR = process.env.EVENTS_DIR || path.join(os.homedir(), 'events');

interface ToolCallTrace {
  tool: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  riskLevel?: string;
}

interface RoutingClassification {
  taskId: string;
  tier: 'premium' | 'standard' | 'fast';
  result: 'success' | 'failure';
  duration: number;
  timestamp: number;
}

export class PreferenceObserver {
  private readonly emaAlpha = 0.15; // EMA 平滑因子（高噪声数据用低 alpha）
  private readonly coldStartThreshold = 50; // 低于此交互数 → cold start

  /**
   * 从 MCP traces 更新工具偏好（每次 tool:call 写入后调用）
   */
  async updateFromToolTrace(trace: ToolCallTrace): Promise<void> {
    try {
      const pref = await this.getOrCreatePreference();

      // 更新工具频率
      const tools = JSON.parse(pref.favoriteTools) as Array<{ name: string; count: number }>;
      const existing = tools.find(t => t.name === trace.tool);
      if (existing) {
        existing.count++;
      } else {
        tools.push({ name: trace.tool, count: 1 });
      }
      tools.sort((a, b) => b.count - a.count);
      pref.favoriteTools = JSON.stringify(tools.slice(0, 10));

      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          favoriteTools: pref.favoriteTools,
          confidence: this.computeConfidence(pref.confidence),
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * @deprecated Pipeline tier routing 已废弃，此方法无调用者。保留空壳。
   */
  async updateFromRoutingFeedback(classifications: RoutingClassification[]): Promise<void> {
    if (classifications.length === 0) return;

    try {
      const pref = await this.getOrCreatePreference();
      const ratio = JSON.parse(pref.modelUsageRatio) as Record<string, number>;

      for (const c of classifications) {
        ratio[c.tier] = (ratio[c.tier] || 0) + 1;
      }

      // 归一化
      const total = Object.values(ratio).reduce((a, b) => a + b, 0);
      for (const k of Object.keys(ratio)) {
        ratio[k] = Math.round((ratio[k] / total) * 100) / 100;
      }

      // 找 preferredModel
      let maxRatio = 0;
      let preferred = pref.preferredModel;
      for (const [tier, r] of Object.entries(ratio)) {
        if (r > maxRatio) {
          maxRatio = r;
          preferred = tier;
        }
      }

      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          preferredModel: preferred,
          modelUsageRatio: JSON.stringify(ratio),
          confidence: this.computeConfidence(pref.confidence),
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 从 channel messages 时间戳推断活跃时段
   */
  async updateActiveHours(messages: Array<{ createdAt: Date }>): Promise<void> {
    if (messages.length === 0) return;

    try {
      const pref = await this.getOrCreatePreference();
      const hourCount = new Array(24).fill(0);

      for (const m of messages) {
        const hour = new Date(m.createdAt).getHours();
        hourCount[hour]++;
      }

      // 取 top 8 活跃小时
      const active = hourCount
        .map((count, hour) => ({ hour, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map(h => h.hour)
        .sort((a, b) => a - b);

      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          activeHours: JSON.stringify(active),
          confidence: this.computeConfidence(pref.confidence),
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 从消息长度分布推断响应风格
   */
  async updateResponseStyle(messages: Array<{ content: string; createdAt?: Date | string }>): Promise<void> {
    if (messages.length === 0) return;

    try {
      const lengths = messages.map(m => m.content.length);
      const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;

      let style: string;
      if (avg < 50) style = 'concise';
      else if (avg <= 200) style = 'balanced';
      else style = 'detailed';

      const pref = await this.getOrCreatePreference();

      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          responseStyle: style,
          avgMessageLength: Math.round(avg),
          messageFrequency: this.estimateFrequency(messages),
          confidence: this.computeConfidence(pref.confidence),
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 从知识确认率推断自动审批阈值
   */
  async updateAutoApproveThreshold(confirmed: number, rejected: number): Promise<void> {
    if (confirmed + rejected < 5) return; // 样本不够

    try {
      const rate = confirmed / (confirmed + rejected);
      let threshold: number;

      if (rate > 0.8) threshold = 0.5; // 大部分确认 → 可降低阈值
      else if (rate > 0.5) threshold = 0.7;
      else threshold = 0.85; // 大部分拒绝 → 保持高标准

      const pref = await this.getOrCreatePreference();

      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          autoApproveThreshold: Math.round(threshold * 100) / 100,
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 获取当前偏好（供 Harness prompt injection 使用）
   */
  async getPreferences(): Promise<Record<string, any> | null> {
    try {
      const pref = await prisma.userPreference.findFirst({
        where: { userId: 'default' },
      });
      if (!pref || pref.confidence < 0.3) return null;

      return {
        preferredModel: pref.preferredModel,
        modelUsageRatio: JSON.parse(pref.modelUsageRatio),
        responseStyle: pref.responseStyle,
        activeHours: JSON.parse(pref.activeHours),
        favoriteTools: JSON.parse(pref.favoriteTools),
        autoApproveThreshold: pref.autoApproveThreshold,
        confidence: pref.confidence,
      };
    } catch {
      return null;
    }
  }

  /**
   * 格式化偏好为 prompt 注入片段
   */
  async formatForPrompt(): Promise<string> {
    const prefs = await this.getPreferences();
    if (!prefs) return '';

    const lines: string[] = [];
    if (prefs.responseStyle) lines.push(`- 用户偏好${prefs.responseStyle}回复`);
    if (prefs.preferredModel) lines.push(`- 常用模型: ${prefs.preferredModel}`);
    if (prefs.activeHours?.length) {
      const hours = prefs.activeHours.join(',');
      lines.push(`- 活跃时段: ${hours} 点`);
    }

    if (lines.length === 0) return '';
    return `\n## 用户偏好 (推断)\n${lines.join('\n')}\n`;
  }

  /**
   * 从 pattern_report 更新交互模式偏好 (B9-025)
   */
  async updateFromPatternReport(distribution: Record<string, number>, recurring: Array<{ type: string; count: number; successRate: number; lastSeen: string }>): Promise<void> {
    try {
      const pref = await this.getOrCreatePreference();

      // Merge distribution with existing — support both old (workflowDistribution) and new (patternDistribution) column names
      const rawExisting = (pref as any).patternDistribution || (pref as any).workflowDistribution;
      const existing = rawExisting ? JSON.parse(rawExisting) as Record<string, number> : {};
      for (const [k, v] of Object.entries(distribution)) {
        existing[k] = (existing[k] || 0) + v;
      }

      // High-frequency types (>= 5 in a week)
      const preferred = Object.entries(existing)
        .filter(([_, count]) => count >= 5)
        .sort((a, b) => b[1] - a[1])
        .map(([type]) => type)
        .slice(0, 5);

      await (prisma as any).userPreference.update({
        where: { id: pref.id },
        data: {
          patternDistribution: JSON.stringify(existing),
          recurringPatterns: JSON.stringify(recurring),
          preferredPatternTypes: JSON.stringify(preferred),
          confidence: this.computeConfidence(pref.confidence),
          lastInferredAt: new Date(),
        },
      });
    } catch (err) {
      /* non-blocking */
    }
  }

  // ── private ──

  private async getOrCreatePreference() {
    let pref = await prisma.userPreference.findFirst({
      where: { userId: 'default' },
    });
    if (!pref) {
      pref = await prisma.userPreference.create({
        data: {
          userId: 'default',
          confidence: 0.3,
        },
      });
    }
    return pref;
  }

  private computeConfidence(current: number): number {
    // EMA 平滑递增到足够交互后提升
    const next = current + (1 - current) * this.emaAlpha;
    return Math.round(next * 1000) / 1000;
  }

  private estimateFrequency(messages: Array<{ createdAt?: Date | string }>): number {
    if (messages.length < 2) return 0;
    const timestamps = messages
      .map(m => (m.createdAt ? new Date(m.createdAt).getTime() : 0))
      .filter(t => t > 0)
      .sort();
    if (timestamps.length < 2) return 0;

    const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
    const spanHours = spanMs / 3600000;
    if (spanHours < 0.1) return messages.length; // avoid division by very small numbers

    return Math.round((messages.length / spanHours) * 10) / 10;
  }
}

export const preferenceObserver = new PreferenceObserver();
