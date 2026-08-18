/**
 * Provider Usage — per-provider usage 提取器（#134）
 *
 * 背景（#133 落账能力矩阵）：usage 解析链原为 claude schema 专用，opencode/codex
 * 的 CLI 上报吃不下。本模块按 provider 分流，统一产出 ProviderUsage；
 * CLI 未上报 usage（kimi）→ null（诚实口径，不编造）。
 *
 * 各 provider 的原始事件形态（fixture 见 __tests__/provider-usage.test.ts）：
 *   claude:   stream-json 末行 result 事件，modelUsage.* 跨轮累积（优先）；
 *             缺失时回退各事件 usage.* 聚合（extractUsage）
 *   opencode: step_finish 事件 part.tokens = {input, output, reasoning, cache:{read, write}} + cost，
 *             多 step 累加（reasoning 不计入四桶——与 output 的包含关系无公开口径，避免重复计）
 *   codex:    turn.completed 事件 usage = {input_tokens, cached_input_tokens,
 *             cache_write_input_tokens?, output_tokens, reasoning_output_tokens}，多 turn 累加。
 *             注意 codex 沿袭 responses 线协议口径：input_tokens **含** cached_input_tokens
 *             （子集），提取时归一化为「非缓存 input」保持四桶互斥（与 claude modelUsage /
 *             opencode tokens.input 同口径），否则 billed 四桶直加会双计 cacheRead
 *   kimi:     0.34.0–0.36.x stream-json 无 usage 出口（仅 meta/assistant 事件）→ null
 */

import { parseSessionMetrics } from './session-metrics';
import { parseStreamEvents, extractUsage } from '../llm/stream-json-parser';

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  numTurns?: number;
  model?: string;
}

/**
 * 按 provider 从原始 CLI stdout 提取 token 用量。
 * 未知 provider 按 claude schema 兜底（claude 兼容端点是常态）。
 * 提取不到任何 token → null（调用方据此标 executionSource='unavailable'，不编造 0）。
 */
export function extractProviderUsage(provider: string, rawOutput: string): ProviderUsage | null {
  switch (provider) {
    case 'opencode':
      return extractOpencodeUsage(rawOutput);
    case 'codex':
      return extractCodexUsage(rawOutput);
    case 'kimi':
      return null;
    default:
      return extractClaudeUsage(rawOutput);
  }
}

/** claude（及未知 provider 兜底）：modelUsage 累积优先，stream 事件 usage 聚合回退 */
function extractClaudeUsage(rawOutput: string): ProviderUsage | null {
  const m = parseSessionMetrics(rawOutput);
  if (m.tokenInput + m.tokenOutput + m.tokenCacheRead + m.tokenCacheWrite > 0) {
    return {
      inputTokens: m.tokenInput,
      outputTokens: m.tokenOutput,
      cacheReadTokens: m.tokenCacheRead,
      cacheCreationTokens: m.tokenCacheWrite,
      ...(m.costUsd ? { costUsd: m.costUsd } : {}),
      ...(m.numTurns ? { numTurns: m.numTurns } : {}),
      ...(m.modelName ? { model: m.modelName } : {}),
    };
  }
  const u = extractUsage(parseStreamEvents(rawOutput));
  if (u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens > 0) {
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
      ...(u.model ? { model: u.model } : {}),
    };
  }
  return null;
}

/** 逐行 JSON.parse（跳过非 JSON 行），opencode/codex 事件形态与 StreamEvent 不同，不复用其类型 */
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

/** opencode：step_finish part.tokens 多 step 累加 */
function extractOpencodeUsage(rawOutput: string): ProviderUsage | null {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, costUsd = 0;
  let seen = false;
  for (const event of parseJsonLines(rawOutput)) {
    if (event.type !== 'step_finish') continue;
    const part = (event.part || {}) as Record<string, unknown>;
    const tokens = part.tokens as Record<string, unknown> | undefined;
    if (!tokens) continue;
    seen = true;
    inputTokens += (tokens.input as number) || 0;
    outputTokens += (tokens.output as number) || 0;
    const cache = (tokens.cache || {}) as Record<string, unknown>;
    cacheReadTokens += (cache.read as number) || 0;
    cacheCreationTokens += (cache.write as number) || 0;
    if (typeof part.cost === 'number') costUsd += part.cost;
  }
  if (!seen) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(costUsd ? { costUsd } : {}),
  };
}

/** codex：turn.completed usage 多 turn 累加；input_tokens 含 cached 子集，归一化为非缓存 input */
function extractCodexUsage(rawOutput: string): ProviderUsage | null {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
  let seen = false;
  for (const event of parseJsonLines(rawOutput)) {
    if (event.type !== 'turn.completed') continue;
    const usage = event.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    seen = true;
    const cached = (usage.cached_input_tokens as number) || 0;
    inputTokens += Math.max(((usage.input_tokens as number) || 0) - cached, 0);
    outputTokens += (usage.output_tokens as number) || 0;
    cacheReadTokens += cached;
    cacheCreationTokens += (usage.cache_write_input_tokens as number) || 0;
  }
  if (!seen) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}
