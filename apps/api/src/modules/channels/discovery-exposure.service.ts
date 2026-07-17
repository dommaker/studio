/**
 * Discovery Exposure Service — G33
 *
 * Unified exposure channel for Analyst/Reviewer discoveries.
 * Posts discovery cards to #系统 channel (no separate channel needed).
 * Non-blocking: errors are logged but never thrown to caller.
 */
import { logger, eventBus, FileStore } from '@dommaker/studio-shared';

export interface DiscoveryEntry {
  source: 'analyst' | 'reviewer';
  type: 'tech_debt' | 'bug' | 'improvement' | 'security' | 'deprecation' | 'observation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  title: string;
  description: string;
  effort?: string;
}

export class DiscoveryExposureService {
  private readonly COOLDOWN_MS = 24 * 60 * 60 * 1000;
  private fileStore: FileStore;

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore ?? new FileStore();
  }

  async expose(discoveries: DiscoveryEntry[]): Promise<void> {
    if (!discoveries?.length) return;
    try {
      for (const d of discoveries) {
        if (await this.isDuplicate(d.title)) continue;

        // Post to #系统 channel (reuse existing channel, no new channel needed)
        const sysChannel = (await this.fileStore.listChannels({ name: '#系统' }))[0] ?? null;
        if (!sysChannel) continue;

        const { channelMessageService } = await import('./channel-message.service.js');
        await channelMessageService.createAgentMessage(
          sysChannel.id,
          d.source === 'analyst' ? 'Analyst' : 'Reviewer',
          this.formatCard(d),
          { meta: { cardType: 'discovery', source: d.source, type: d.type, severity: d.severity, title: d.title } },
        );

        // Write to KnowledgeBus for cross-session awareness
        try {
          const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');
          await knowledgeBus.recordPattern({
            source: d.source as any,
            type: 'pitfall',
            title: `[Discovery] ${d.title}`,
            content: `${d.description}\nFile: ${d.file}`,
            severity: d.severity === 'critical' ? 'critical' : 'warning',
            timestamp: Date.now(),
          });
        } catch {}

        logger.info('[DiscoveryExposure] Exposed', { title: d.title, severity: d.severity });
      }
    } catch (e) {
      logger.warn('[DiscoveryExposure] Failed', { error: String(e) });
    }
  }

  private async isDuplicate(title: string): Promise<boolean> {
    try {
      const cutoff = new Date(Date.now() - this.COOLDOWN_MS);
      const cutoffIso = cutoff.toISOString();
      const existing = await this.fileStore.queryAllMessages({
        agentNames: ['Analyst', 'Reviewer'],
      });
      // 过滤时间 + 检查 meta title 重复
      const recent = existing.filter(m => new Date(m.createdAt).getTime() >= cutoff.getTime());
      if (recent.length === 0) return false;
      return recent.some(msg => {
        try {
          const meta = typeof msg.meta === 'string' ? JSON.parse(msg.meta) : msg.meta;
          return meta?.title === title;
        } catch { return false; }
      });
    } catch { return false; }
  }

  private formatCard(d: DiscoveryEntry): string {
    const icons: Record<string, string> = { critical: '🚨', high: '🔴', medium: '🟡', low: '🟢' };
    const labels: Record<string, string> = {
      tech_debt: '技术债', bug: '潜在 Bug', improvement: '改进机会',
      security: '安全', deprecation: '废弃', observation: '发现',
    };
    return [
      `## ${icons[d.severity] || '💡'} ${d.title}`,
      '',
      `**文件**: \`${d.file}\``,
      `**类型**: ${labels[d.type] || d.type} | **严重度**: ${d.severity}${d.effort ? ` | **预估**: ${d.effort}` : ''}`,
      `**来源**: ${d.source === 'analyst' ? '需求分析中发现' : '代码审查中发现'}`,
      '',
      d.description,
    ].join('\n');
  }
}

export const discoveryExposure = new DiscoveryExposureService();
