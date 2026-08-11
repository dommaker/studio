/**
 * MCP Tools — Agent-First 系统健康与事件
 *
 * T3 拆分：自 tools.ts 原样提取（systemHealth / emitEvent）。
 */

import { resolveStudioEventsFile, writeStudioEvent } from '../../utils/studio-events.js';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
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

    // 4. 事件流活性探活（D18: 统一事件文件 30s 内有写入即视为活跃）
    let eventsDaemonAlive = false;
    try {
      const eventsFile = resolveStudioEventsFile();
      if (fsMod.existsSync(eventsFile)) {
        const stat = fsMod.statSync(eventsFile);
        eventsDaemonAlive = Date.now() - stat.mtimeMs < 30_000;
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
  description: `Agent 向统一事件流发射结构化事件（D18：写入 ${studioPath('logs', 'studio-events.jsonl')}，测试期隔离）。用于 Agent 间的异步通信和系统级通知。类型以 "agent:" 为前缀。`,
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
    // D18: 统一事件写入入口（StudioEvent 形态；空 payload 拒收 —— message 必填，恒非空）
    await writeStudioEvent(String(input.eventType), {
      message: input.message,
      severity: input.severity || 'info',
      details: input.details || {},
    }, { source: 'mcp' });

    return {
      emitted: true,
      eventType: input.eventType,
      routedTo: 'unified studio-events.jsonl (D18)',
    };
  },
};

export const systemTools: RegisteredTool[] = [
  systemHealth,
  emitEvent,
];
