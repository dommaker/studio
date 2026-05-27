/**
 * Discovery Exposure Service — G33
 *
 * Unified exposure channel for Analyst/Reviewer discoveries.
 * Posts discovery cards to #系统 channel (no separate channel needed).
 * Non-blocking: errors are logged but never thrown to caller.
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';

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

  async expose(discoveries: DiscoveryEntry[], sourceChannelId?: string): Promise<void> {
    if (!discoveries?.length) return;
    try {
      for (const d of discoveries) {
        if (await this.isDuplicate(d.title)) continue;

        // Post to #系统 channel (reuse existing channel, no new channel needed)
        const sysChannel = await prisma.channel.findUnique({ where: { name: '#系统' } });
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

        // G33: high/critical discoveries trigger automatic @analyst for pipeline execution
        if (d.severity === 'high' || d.severity === 'critical') {
          this.autoTriggerAnalyst(d, sourceChannelId).catch(e =>
            logger.warn('[DiscoveryExposure] auto-trigger failed', { error: String(e) })
          );
        }

        logger.info('[DiscoveryExposure] Exposed', { title: d.title, severity: d.severity });
      }
    } catch (e) {
      logger.warn('[DiscoveryExposure] Failed', { error: String(e) });
    }
  }

  /** high/critical 发现自动 @analyst → 管线执行，人只看到留痕 */
  private async autoTriggerAnalyst(d: DiscoveryEntry, sourceChannelId?: string): Promise<void> {
    try {
      const channelId = sourceChannelId || (await prisma.channel.findFirst({ where: { type: 'rnd' } }))?.id;
      if (!channelId) return;

      const port = process.env.PORT || '3001';
      const resp = await fetch(`http://127.0.0.1:${port}/api/v1/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `@analyst [自动发现] ${d.title}\n\n来源: 代码探索自动发现\n文件: ${d.file}\n严重度: ${d.severity}\n\n${d.description}`,
        }),
      });
      const result = await resp.json() as { success: boolean };
      if (result.success) {
        logger.info('[DiscoveryExposure] Auto-triggered @analyst', { title: d.title });
      }
    } catch (e) {
      logger.warn('[DiscoveryExposure] autoTriggerAnalyst failed', { error: String(e) });
    }
  }

  private async isDuplicate(title: string): Promise<boolean> {
    try {
      const cutoff = new Date(Date.now() - this.COOLDOWN_MS);
      const existing = await prisma.channelMessage.findMany({
        where: {
          agentName: { in: ['Analyst', 'Reviewer'] },
          createdAt: { gte: cutoff },
        },
        select: { meta: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      if (existing.length === 0) return false;
      return existing.some(msg => {
        try {
          const m = typeof msg.meta === 'string' ? JSON.parse(msg.meta) : msg.meta;
          return m?.title === title;
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
