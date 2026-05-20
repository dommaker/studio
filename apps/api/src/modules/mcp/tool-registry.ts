/**
 * MCP Tool Registry — dynamic registration, health, rate limiting
 */

import { logger } from '@dommaker/studio-shared';
import { preferenceObserver } from '../knowledge/preference-observer.js';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (input: Record<string, any>) => Promise<any>;
  category?: string;
  version?: string;
  enabled: boolean;
  requiredPermissions?: string[];
  /** G2: 工具风险级别。high=破坏性操作需确认，low=只读安全 */
  riskLevel?: ToolRiskLevel;
}

interface ToolStats {
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  lastCallAt?: number;
  avgDuration: number;
}

interface RateLimitEntry {
  timestamps: number[];
}

export class MCPToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private stats = new Map<string, ToolStats>();
  private rateLimits = new Map<string, RateLimitEntry>();

  // Per-tool rate limit config: { maxCalls, windowMs }
  private rateLimitConfig: { maxCalls: number; windowMs: number } = {
    maxCalls: 100,
    windowMs: 60_000, // 1 minute
  };

  /**
   * Register a tool
   */
  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
    if (!this.stats.has(tool.name)) {
      this.stats.set(tool.name, { totalCalls: 0, successCalls: 0, errorCalls: 0, avgDuration: 0 });
    }
    logger.debug(`[MCP Registry] Registered: ${tool.name}`);
  }

  /**
   * Register multiple tools
   */
  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
    logger.info(`[MCP Registry] ${tools.length} tools registered`);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) logger.info(`[MCP Registry] Unregistered: ${name}`);
    return deleted;
  }

  /**
   * Get tool by name
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all tools (optionally filtered by enabled)
   */
  list(includeDisabled = false): RegisteredTool[] {
    const all = Array.from(this.tools.values());
    return includeDisabled ? all : all.filter(t => t.enabled);
  }

  /**
   * Enable/disable a tool
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    tool.enabled = enabled;
    logger.info(`[MCP Registry] ${name} ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  /**
   * Get tool schemas (for MCP tools/list)
   */
  getSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, any> }> {
    return this.list().map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  /**
   * Check rate limit for a tool
   */
  checkRateLimit(name: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const entry = this.rateLimits.get(name) || { timestamps: [] };

    // Clean old timestamps
    entry.timestamps = entry.timestamps.filter(t => now - t < this.rateLimitConfig.windowMs);

    if (entry.timestamps.length >= this.rateLimitConfig.maxCalls) {
      const oldest = entry.timestamps[0];
      const retryAfterMs = this.rateLimitConfig.windowMs - (now - oldest);
      return { allowed: false, retryAfterMs };
    }

    entry.timestamps.push(now);
    this.rateLimits.set(name, entry);
    return { allowed: true };
  }

  /**
   * Record a tool call for stats + trace
   */
  recordCall(name: string, success: boolean, duration: number, caller?: string): void {
    const stats = this.stats.get(name);
    if (!stats) return;
    stats.totalCalls++;
    if (success) stats.successCalls++;
    else stats.errorCalls++;
    stats.avgDuration = Math.round((stats.avgDuration * (stats.totalCalls - 1) + duration) / stats.totalCalls);
    stats.lastCallAt = Date.now();

    // G2: Trace all tool calls
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const dir = process.env.EVENTS_DIR || path.join(os.homedir(), 'events');
      fs.mkdirSync(dir, { recursive: true });
      const tool = this.tools.get(name);
      fs.appendFileSync(
        path.join(dir, 'studio.jsonl'),
        JSON.stringify({
          type: 'tool:call',
          tool: name,
          riskLevel: tool?.riskLevel || 'low',
          success,
          durationMs: duration,
          caller,
          timestamp: Date.now(),
        }) + '\n',
      );
    } catch { /* non-blocking */ }

    // G-001: 更新用户偏好（异步，不阻塞）
    preferenceObserver.updateFromToolTrace({
      tool: name,
      success,
      durationMs: duration,
      timestamp: Date.now(),
      riskLevel: this.tools.get(name)?.riskLevel || 'low',
    }).catch(() => { /* non-blocking */ });
  }

  /**
   * Get stats for all tools
   */
  getStats(): Record<string, ToolStats> {
    const result: Record<string, ToolStats> = {};
    for (const [name, stats] of this.stats) {
      result[name] = { ...stats };
    }
    return result;
  }

  /**
   * Get health status
   */
  getHealth(): { status: 'healthy' | 'degraded' | 'unhealthy'; tools: Array<{ name: string; enabled: boolean; errorRate: number; lastCallAt?: number }> } {
    const all = Array.from(this.tools.values());
    const enabledCount = all.filter(t => t.enabled).length;
    const ratio = all.length > 0 ? enabledCount / all.length : 1;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (ratio >= 0.9) status = 'healthy';
    else if (ratio >= 0.5) status = 'degraded';
    else status = 'unhealthy';

    const tools = all.map(t => {
      const s = this.stats.get(t.name);
      return {
        name: t.name,
        enabled: t.enabled,
        errorRate: s && s.totalCalls > 0 ? Math.round((s.errorCalls / s.totalCalls) * 100) : 0,
        lastCallAt: s?.lastCallAt,
      };
    });

    return { status, tools };
  }

  /**
   * Update rate limit config
   */
  setRateLimitConfig(config: { maxCalls?: number; windowMs?: number }): void {
    if (config.maxCalls !== undefined) this.rateLimitConfig.maxCalls = config.maxCalls;
    if (config.windowMs !== undefined) this.rateLimitConfig.windowMs = config.windowMs;
  }

  get toolCount(): number {
    return this.tools.size;
  }
}

export const toolRegistry = new MCPToolRegistry();
