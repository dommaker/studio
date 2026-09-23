/**
 * CLI 会话号提取（#639，方向 D：按 CLI 真实会话号续用）
 *
 * Studio 档案会话号（metadata.sessionId）是自建 UUID，kimi/codex/opencode 三家 CLI
 * 不认识；续用必须点名 CLI 自己的真实会话号。本模块从本步原始 stdout（rawOutput）
 * 解析各 provider 的真实会话号：
 *   claude:   result 行 session_id（复用 parseSessionMetrics 末行口径）
 *   kimi:     meta 行 {"role":"meta","type":"session.resume_hint","session_id":...}
 *   codex:    thread.started 事件 thread_id
 *   opencode: 任意事件顶层 sessionID
 * 读不到 → null（诚实口径，不编造——调用方按「无真实会话号 → 新会话」处理）。
 */

import { parseSessionMetrics } from './session-metrics';

/** 逐行 JSON.parse（跳过非 JSON 行） */
function parseJsonLines(rawOutput: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch { /* skip non-JSON lines */ }
  }
  return out;
}

function firstStringField(rawOutput: string, match: (obj: Record<string, unknown>) => unknown): string | null {
  for (const obj of parseJsonLines(rawOutput)) {
    const v = match(obj);
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * 按 provider 从原始 CLI stdout 提取真实会话号。
 * 未知 provider 按 claude schema 兜底（claude 兼容端点是常态，同 extractProviderUsage 先例）。
 */
export function extractCliSessionId(provider: string, rawOutput: string): string | null {
  if (!rawOutput) return null;
  switch (provider) {
    case 'kimi':
      return firstStringField(rawOutput, o => o.type === 'session.resume_hint' ? o.session_id : undefined);
    case 'codex':
      return firstStringField(rawOutput, o => o.type === 'thread.started' ? o.thread_id : undefined);
    case 'opencode':
      return firstStringField(rawOutput, o => o.sessionID);
    default: {
      const id = parseSessionMetrics(rawOutput).sessionId;
      return id || null;
    }
  }
}
