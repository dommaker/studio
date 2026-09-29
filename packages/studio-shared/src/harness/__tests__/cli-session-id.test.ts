/**
 * CLI 会话号提取 — tests（#639）
 *
 * fixture 与 provider-usage.test.ts 同源（#133 落账能力矩阵存档的真实 CLI 输出内联化）。
 */
import { describe, it, expect } from 'vitest';
import { extractCliSessionId } from '../cli-session-id.js';

// claude --print --output-format stream-json（result 事件携带 session_id）
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"init","session_id":"410653b6-4d19-441d-828f-43c8a5c60526"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"410653b6-4d19-441d-828f-43c8a5c60526","usage":{"input_tokens":1,"output_tokens":1}}',
].join('\n');

// kimi --output-format stream-json（meta 行 session.resume_hint 携带 session_id）
const KIMI_STREAM = [
  '{"role":"meta","type":"system.version","version":"0.36.1"}',
  '{"role":"assistant","content":"OK"}',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_6bc14e1d","command":"kimi -r session_6bc14e1d"}',
].join('\n');

// codex exec --json（thread.started 事件携带 thread_id）
const CODEX_JSON = [
  '{"type":"thread.started","thread_id":"019ffaa8-a378-79e2-af4f-f618e93d4442"}',
  '{"type":"turn.started"}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
].join('\n');

// opencode run --format json（每个事件携带 sessionID）
const OPENCODE_JSON = [
  '{"type":"step_start","timestamp":1786613920803,"sessionID":"ses_0058","part":{"type":"step-start"}}',
  '{"type":"step_finish","timestamp":1786613922636,"sessionID":"ses_0058","part":{"type":"step-finish","tokens":{"input":1,"output":1}}}',
].join('\n');

describe('extractCliSessionId（#639：各 provider CLI 真实会话号，读不到 → null 不编造）', () => {
  it('claude：result 行 session_id', () => {
    expect(extractCliSessionId('claude', CLAUDE_STREAM)).toBe('410653b6-4d19-441d-828f-43c8a5c60526');
  });

  it('kimi：session.resume_hint meta 行 session_id', () => {
    expect(extractCliSessionId('kimi', KIMI_STREAM)).toBe('session_6bc14e1d');
  });

  it('codex：thread.started 事件 thread_id', () => {
    expect(extractCliSessionId('codex', CODEX_JSON)).toBe('019ffaa8-a378-79e2-af4f-f618e93d4442');
  });

  it('opencode：任意事件 sessionID', () => {
    expect(extractCliSessionId('opencode', OPENCODE_JSON)).toBe('ses_0058');
  });

  it('流内无标识 → null（kimi 无 resume_hint / codex 无 thread.started / opencode 无 sessionID）', () => {
    expect(extractCliSessionId('kimi', '{"role":"assistant","content":"OK"}')).toBeNull();
    expect(extractCliSessionId('codex', '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')).toBeNull();
    expect(extractCliSessionId('opencode', '{"type":"text","part":{"type":"text","text":"OK"}}')).toBeNull();
  });

  it('非 JSON / 空输出 → null', () => {
    expect(extractCliSessionId('claude', 'not json at all')).toBeNull();
    expect(extractCliSessionId('kimi', '')).toBeNull();
    expect(extractCliSessionId('opencode', '')).toBeNull();
  });

  it('未知 provider 按 claude schema 兜底', () => {
    expect(extractCliSessionId('some-custom-provider', CLAUDE_STREAM)).toBe('410653b6-4d19-441d-828f-43c8a5c60526');
  });
});
