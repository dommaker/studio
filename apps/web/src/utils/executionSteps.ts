// 执行步共享纯函数（#396 自 ExecutionSteps 抽取，ExecutionFlow 共用）：步事件并集合并 / 最近进展 / token 缩写
import type { ExecutionStepEvent } from '../api/workunit';

/** 步事件并集合并——按 executionId-step 去重（后到的覆盖），按步号升序；SSE 负载 append 与 REST 打底/重连 refetch 共用 */
export function mergeStepEvents(base: ExecutionStepEvent[], incoming: ExecutionStepEvent[]): ExecutionStepEvent[] {
  if (incoming.length === 0) return base;
  const byKey = new Map<string, ExecutionStepEvent>();
  for (const s of base) byKey.set(`${s.executionId}-${s.step}`, s);
  for (const s of incoming) byKey.set(`${s.executionId}-${s.step}`, s);
  return [...byKey.values()].sort((a, b) => a.step - b.step || a.at.localeCompare(b.at));
}

/** progressLog 最后一条带 summary 的条目（畸形条目跳过） */
export function lastProgressEntry(log: unknown): { step?: number; summary: string } | null {
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] as { step?: unknown; summary?: unknown } | null;
    if (e && typeof e.summary === 'string' && e.summary) {
      return { step: typeof e.step === 'number' ? e.step : undefined, summary: e.summary };
    }
  }
  return null;
}

/** token 缩写（≥1000 → 一位小数 k） */
export function formatStepTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
