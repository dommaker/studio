/**
 * Provider Usage — tests
 *
 * #134: per-provider usage 提取器。fixture 取自 #133 落账能力矩阵存档的
 * 真实 CLI 输出（.scratch/usage-ledger-verify/raw-*.jsonl，2026-08-13）内联化。
 */
import { describe, it, expect } from 'vitest';
import { extractProviderUsage } from '../provider-usage.js';

// claude --print --output-format stream-json（末行 result 事件，含 modelUsage 累积）
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","session_id":"410653b6-4d19-441d-828f-43c8a5c60526"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]},"usage":{"input_tokens":33135,"output_tokens":13,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":4080,"num_turns":1,"result":"OK","session_id":"410653b6-4d19-441d-828f-43c8a5c60526","total_cost_usd":0.166,"usage":{"input_tokens":33135,"output_tokens":13,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"service_tier":"standard"},"modelUsage":{"deepseek-v4-pro[1m]":{"inputTokens":33135,"outputTokens":13,"cacheReadInputTokens":12000,"cacheCreationInputTokens":4000,"costUSD":0.166}}}',
].join('\n');

// opencode run --format json（step_finish.part.tokens + cost）
const OPENCODE_JSON = [
  '{"type":"step_start","timestamp":1786613920803,"sessionID":"ses_0058","part":{"type":"step-start"}}',
  '{"type":"text","timestamp":1786613922589,"sessionID":"ses_0058","part":{"type":"text","text":"OK"}}',
  '{"type":"step_finish","timestamp":1786613922636,"sessionID":"ses_0058","part":{"reason":"stop","type":"step-finish","tokens":{"total":12075,"input":12073,"output":2,"reasoning":0,"cache":{"write":100,"read":5000}},"cost":0.005253495}}',
].join('\n');

// codex exec --json（turn.completed.usage）
const CODEX_JSON = [
  '{"type":"thread.started","thread_id":"019ffaa8-a378-79e2-af4f-f618e93d4442"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"OK"}}',
  '{"type":"turn.completed","usage":{"input_tokens":13618,"cached_input_tokens":9728,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
].join('\n');

// kimi --output-format stream-json（0.34.0/0.36.x：meta/assistant 事件，无 usage 出口）
const KIMI_STREAM = [
  '{"role":"meta","type":"system.version","version":"0.36.1"}',
  '{"role":"assistant","content":"OK"}',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_6bc14e1d","command":"kimi -r session_6bc14e1d"}',
].join('\n');

describe('extractProviderUsage', () => {
  describe('claude', () => {
    it('从 result 事件 modelUsage 提取全量 tokens（含 cache）', () => {
      const u = extractProviderUsage('claude', CLAUDE_STREAM);
      expect(u).toEqual({
        inputTokens: 33135,
        outputTokens: 13,
        cacheReadTokens: 12000,
        cacheCreationTokens: 4000,
        costUsd: 0.166,
        numTurns: 1,
        model: 'deepseek-v4-pro[1m]',
      });
    });

    it('modelUsage 缺失时回退 stream 事件 usage 聚合', () => {
      const stream = '{"type":"assistant","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}\n'
        + '{"type":"result","result":"ok","is_error":false}\n';
      const u = extractProviderUsage('claude', stream);
      expect(u).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
      });
    });

    it('完全无 usage → null（不编造）', () => {
      expect(extractProviderUsage('claude', 'not json at all')).toBeNull();
      expect(extractProviderUsage('claude', '')).toBeNull();
    });
  });

  describe('opencode', () => {
    it('从 step_finish part.tokens 提取 input/output/cache + cost', () => {
      const u = extractProviderUsage('opencode', OPENCODE_JSON);
      expect(u).toEqual({
        inputTokens: 12073,
        outputTokens: 2,
        cacheReadTokens: 5000,
        cacheCreationTokens: 100,
        costUsd: 0.005253495,
      });
    });

    it('多 step_finish 聚合累加', () => {
      const multi = [
        '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":100,"output":10,"reasoning":0,"cache":{"write":0,"read":50}},"cost":0.125}}',
        '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":200,"output":20,"reasoning":0,"cache":{"write":5,"read":60}},"cost":0.125}}',
      ].join('\n');
      const u = extractProviderUsage('opencode', multi);
      expect(u).toEqual({
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 110,
        cacheCreationTokens: 5,
        costUsd: 0.25,
      });
    });

    it('无 step_finish → null', () => {
      expect(extractProviderUsage('opencode', '{"type":"text","part":{"type":"text","text":"OK"}}')).toBeNull();
    });
  });

  describe('codex', () => {
    it('从 turn.completed usage 提取（input_tokens 含 cached 子集，归一化为非缓存 input）', () => {
      const u = extractProviderUsage('codex', CODEX_JSON);
      expect(u).toEqual({
        inputTokens: 3890, // 13618 - 9728
        outputTokens: 2,
        cacheReadTokens: 9728,
        cacheCreationTokens: 0,
      });
    });

    it('turn.failed / 无 turn.completed → null', () => {
      const failed = '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}';
      expect(extractProviderUsage('codex', failed)).toBeNull();
    });
  });

  describe('kimi', () => {
    it('CLI 无 usage 出口 → null（诚实口径，不编造）', () => {
      expect(extractProviderUsage('kimi', KIMI_STREAM)).toBeNull();
    });
  });

  describe('未知 provider', () => {
    it('按 claude schema 兜底解析', () => {
      const u = extractProviderUsage('some-custom-provider', CLAUDE_STREAM);
      expect(u?.inputTokens).toBe(33135);
    });
  });
});
