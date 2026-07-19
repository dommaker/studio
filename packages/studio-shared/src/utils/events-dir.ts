import { homedir } from 'os';
import { join } from 'path';

/**
 * R2 事件目录统一（断点 D，docs/plans/2026-07-flywheel-repair.md）。
 *
 * 唯一事件目录 = `~/.studio/events`，可用环境变量覆盖。
 * 环境变量优先级（收敛为一个规范名 + 向后兼容历史名）：
 *   1. `STUDIO_EVENTS_DIR` — 规范名（优先）
 *   2. `EVENTS_DIR`        — 历史名（向后兼容；apps/api index.ts 与 studio-cli
 *                            启动时仍会把它默认设为 ~/.studio/events）
 *   3. 默认 `~/.studio/events`
 *
 * 所有 studio.jsonl 事件读写方（agent-loop tool traces、PatternMiner、
 * MonitorAgent、AuditorAgent、MCP emitEvent …）必须经此函数解析，
 * 禁止再硬编码 `~/events`。
 *
 * 注意：`~/.studio/logs/studio-events.jsonl`（knowledge consumption/outcome、
 * OKR 等 StudioEvent 流）是另一条已统一的流，不在本 resolver 范围内。
 */
export function resolveEventsDir(): string {
  return process.env.STUDIO_EVENTS_DIR || process.env.EVENTS_DIR || join(homedir(), '.studio', 'events');
}
