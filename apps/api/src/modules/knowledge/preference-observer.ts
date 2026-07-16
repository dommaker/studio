/**
 * PreferenceObserver (G-001) — 从 MCP traces + Channel 消息中推断用户偏好
 *
 * 存储：KnowledgeStore (type=guideline, tags=['preference','user-default'])
 * 增量 EMA 更新，不阻塞主流程。
 * 冷启动：无历史数据时 confidence=0.3，积累 50+ 交互后提升到 0.7+
 */

import { logger } from '@dommaker/studio-shared';

interface PreferenceData {
  favoriteTools: string;         // JSON: Array<{ name: string; count: number }>
  modelUsageRatio: string;       // JSON: Record<string, number>
  preferredModel: string | null;
  responseStyle: string | null;
  activeHours: string;           // JSON: number[]
  autoApproveThreshold: number;
  avgMessageLength: number;
  messageFrequency: number;
  confidence: number;
  lastInferredAt: string | null;
  patternDistribution: string;   // JSON
  recurringPatterns: string;     // JSON
  preferredPatternTypes: string; // JSON
}

const PREFERENCE_ID = 'user-preference-default';

function defaultPrefs(): PreferenceData {
  return {
    favoriteTools: '[]',
    modelUsageRatio: '{}',
    preferredModel: null,
    responseStyle: null,
    activeHours: '[]',
    autoApproveThreshold: 0.7,
    avgMessageLength: 0,
    messageFrequency: 0,
    confidence: 0.3,
    lastInferredAt: null,
    patternDistribution: '{}',
    recurringPatterns: '[]',
    preferredPatternTypes: '[]',
  };
}

interface ToolCallTrace {
  tool: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  riskLevel?: string;
}

export class PreferenceObserver {
  private readonly emaAlpha = 0.15;
  private readonly coldStartThreshold = 50;

  // ── lazy import to avoid circular deps ──

  private async getStore() {
    const { sharedStore } = await import('./knowledge-bus.service.js');
    return { store: sharedStore };
  }

  // ── KnowledgeStore read/write ──

  private async readPrefs(): Promise<PreferenceData> {
    try {
      const { store } = await this.getStore();
      const entries = store.list({ tags: ['preference', 'user-default'] });
      if (entries.length > 0) {
        const data = entries[0] as unknown as { content: string };
        return { ...defaultPrefs(), ...JSON.parse(data.content || '{}') };
      }
    } catch { /* fall through to default */ }
    return defaultPrefs();
  }

  private async writePrefs(data: PreferenceData): Promise<void> {
    try {
      const { store } = await this.getStore();
      store.save({
        id: PREFERENCE_ID,
        type: 'guideline' as any,
        title: '用户偏好',
        content: JSON.stringify(data),
        maturity: 'active' as any,
        layer: 'project',
        created: new Date().toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['preference-observer'],
        projects: [],
        tags: ['preference', 'user-default'],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
        executionResults: [],
        consumptionMode: 'context',
        origin: 'agent',
      } as any);
    } catch (err) {
      logger.warn('[PreferenceObserver] writePrefs failed', { error: String(err) });
    }
  }

  /**
   * 从 MCP traces 更新工具偏好
   */
  async updateFromToolTrace(trace: ToolCallTrace): Promise<void> {
    try {
      const pref = await this.readPrefs();
      const tools = JSON.parse(pref.favoriteTools) as Array<{ name: string; count: number }>;
      const existing = tools.find(t => t.name === trace.tool);
      if (existing) {
        existing.count++;
      } else {
        tools.push({ name: trace.tool, count: 1 });
      }
      tools.sort((a, b) => b.count - a.count);
      pref.favoriteTools = JSON.stringify(tools.slice(0, 10));
      pref.confidence = this.computeConfidence(pref.confidence);
      pref.lastInferredAt = new Date().toISOString();

      await this.writePrefs(pref);
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
      const pref = await this.readPrefs();
      const hourCount = new Array(24).fill(0);
      for (const m of messages) {
        const hour = new Date(m.createdAt).getHours();
        hourCount[hour]++;
      }
      const active = hourCount
        .map((count, hour) => ({ hour, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map(h => h.hour)
        .sort((a, b) => a - b);

      pref.activeHours = JSON.stringify(active);
      pref.confidence = this.computeConfidence(pref.confidence);
      pref.lastInferredAt = new Date().toISOString();

      await this.writePrefs(pref);
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

      const pref = await this.readPrefs();
      pref.responseStyle = style;
      pref.avgMessageLength = Math.round(avg);
      pref.messageFrequency = this.estimateFrequency(messages);
      pref.confidence = this.computeConfidence(pref.confidence);
      pref.lastInferredAt = new Date().toISOString();

      await this.writePrefs(pref);
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 从知识确认率推断自动审批阈值
   */
  async updateAutoApproveThreshold(confirmed: number, rejected: number): Promise<void> {
    if (confirmed + rejected < 5) return;
    try {
      const rate = confirmed / (confirmed + rejected);
      let threshold: number;
      if (rate > 0.8) threshold = 0.5;
      else if (rate > 0.5) threshold = 0.7;
      else threshold = 0.85;

      const pref = await this.readPrefs();
      pref.autoApproveThreshold = Math.round(threshold * 100) / 100;
      pref.lastInferredAt = new Date().toISOString();

      await this.writePrefs(pref);
    } catch (err) {
      /* non-blocking */
    }
  }

  /**
   * 获取当前偏好（供 prompt injection 使用）
   */
  async getPreferences(): Promise<Record<string, any> | null> {
    try {
      const pref = await this.readPrefs();
      if (pref.confidence < 0.3) return null;

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
  async updateFromPatternReport(
    distribution: Record<string, number>,
    recurring: Array<{ type: string; count: number; successRate: number; lastSeen: string }>,
  ): Promise<void> {
    try {
      const pref = await this.readPrefs();
      const existing = JSON.parse(pref.patternDistribution) as Record<string, number>;
      for (const [k, v] of Object.entries(distribution)) {
        existing[k] = (existing[k] || 0) + v;
      }

      const preferred = Object.entries(existing)
        .filter(([_, count]) => count >= 5)
        .sort((a, b) => b[1] - a[1])
        .map(([type]) => type)
        .slice(0, 5);

      pref.patternDistribution = JSON.stringify(existing);
      pref.recurringPatterns = JSON.stringify(recurring);
      pref.preferredPatternTypes = JSON.stringify(preferred);
      pref.confidence = this.computeConfidence(pref.confidence);
      pref.lastInferredAt = new Date().toISOString();

      await this.writePrefs(pref);
    } catch (err) {
      /* non-blocking */
    }
  }

  // ── private ──

  private computeConfidence(current: number): number {
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
    if (spanHours < 0.1) return messages.length;
    return Math.round((messages.length / spanHours) * 10) / 10;
  }
}

export const preferenceObserver = new PreferenceObserver();
