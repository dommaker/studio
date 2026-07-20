/**
 * MCP Tools — Agent-First 系统健康与事件
 *
 * T3 拆分：自 tools.ts 原样提取（systemHealth / emitEvent）。
 */

import { resolveEventsDir } from '@dommaker/studio-shared';
import type { RegisteredTool } from './tool-registry.js';

// ─── Agent-First 系统健康 ───

const systemHealth: RegisteredTool = {
  name: 'systemHealth',
  description: 'Agent-first 系统健康检查：API 状态、知识库统计、Agent 运行状态、管线阶段。Agent 在任何关键操作前应调此 tool 确认系统在线。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const { sharedStore, checkDocumentFreshness } = await import('../knowledge/knowledge-bus.service.js');
    const fsMod = await import('fs');
    const osMod = await import('os');
    const pathMod = await import('path');

    // 1. 系统资源
    const mem = process.memoryUsage();
    const cpu = osMod.loadavg();
    const uptime = process.uptime();

    // 2. 知识库统计
    const entries = sharedStore.list({ excludeArchived: false });
    const byType: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const byMaturity: Record<string, number> = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
      byMaturity[e.maturity] = (byMaturity[e.maturity] || 0) + 1;
    }

    // 3. 设计文档新鲜度
    const staleDocs = checkDocumentFreshness(process.env.REPO_DIR || process.cwd());

    // 4. events-daemon 探活（R2: 统一事件目录）
    let eventsDaemonAlive = false;
    try {
      const eventsDir = resolveEventsDir();
      if (fsMod.existsSync(eventsDir)) {
        const files = fsMod.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files.slice(0, 3)) {
          const stat = fsMod.statSync(pathMod.join(eventsDir, f));
          if (Date.now() - stat.mtimeMs < 30_000) {
            eventsDaemonAlive = true;
            break;
          }
        }
      }
    } catch { /* can't determine */ }

    return {
      system: {
        uptime: `${Math.round(uptime)}s`,
        cpu: cpu.map(v => v.toFixed(2)),
        memory: { heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024), rssMB: Math.round(mem.rss / 1024 / 1024) },
        apiResponding: true,
        eventsDaemonAlive,
      },
      knowledge: {
        total: entries.length,
        byType,
        byLayer,
        byMaturity,
        staleDesignDocs: staleDocs.length,
      },
      flags: {
        needsColdStart: entries.length < 10 && !byLayer?.['system'],
        needsDecay: byMaturity?.['archived'] === undefined || (byMaturity?.['archived'] || 0) === 0,
        healthy: eventsDaemonAlive,
      },
    };
  },
};

const emitEvent: RegisteredTool = {
  name: 'emitEvent',
  description: 'Agent 向事件管线发射结构化事件（写入统一事件目录 ~/.studio/events/studio.jsonl（STUDIO_EVENTS_DIR/EVENTS_DIR 可覆盖），由 events-daemon 路由到 Discord）。用于 Agent 间的异步通信和系统级通知。类型以 "agent:" 为前缀。',
  inputSchema: {
    type: 'object',
    properties: {
      eventType: { type: 'string', description: '事件类型 (如 agent:analysis_done, agent:review_blocked, agent:deploy_complete)' },
      message: { type: 'string', description: '事件消息' },
      severity: { type: 'string', description: '严重度', enum: ['info', 'warning', 'critical'], default: 'info' },
      details: { type: 'object', description: '附加上下文 (goalId, taskId, score 等)' },
    },
    required: ['eventType', 'message'],
  },
  handler: async (input) => {
    const fsMod = await import('fs');
    const pathMod = await import('path');

    const eventsDir = resolveEventsDir();
    try { if (!fsMod.existsSync(eventsDir)) fsMod.mkdirSync(eventsDir, { recursive: true }); } catch { /* best-effort */ }

    const event = {
      type: input.eventType,
      message: input.message,
      severity: input.severity || 'info',
      details: input.details || {},
      timestamp: new Date().toISOString(),
    };

    try {
      fsMod.appendFileSync(pathMod.join(eventsDir, 'studio.jsonl'), JSON.stringify(event) + '\n');
    } catch { /* non-blocking */ }

    return {
      emitted: true,
      eventType: input.eventType,
      routedTo: 'events-daemon → Discord (if goal:/monitor:/agent: prefix)',
    };
  },
};

export const systemTools: RegisteredTool[] = [
  systemHealth,
  emitEvent,
];
