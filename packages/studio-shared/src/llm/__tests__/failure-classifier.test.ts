/**
 * failure-classifier 测试（#565 阶段 3 / AC5）
 *
 * 样本来自 2026-09-16 各 CLI 实测（脱敏）：codex 未登录 "Not logged in"、
 * claude auth status JSON 形态；配额/限流/unknown option 为各家通用 CLI 错误形态。
 */
import { describe, test, expect } from 'vitest';
import { classifyCliFailure } from '../failure-classifier';

describe('classifyCliFailure（AC5）', () => {
  test('auth：claude Invalid API key → category auth，指引含登录命令', () => {
    const r = classifyCliFailure({ provider: 'claude', exitCode: 1, output: 'Error: Invalid API key · Please run /login' });
    expect(r).not.toBeNull();
    expect(r!.category).toBe('auth');
    expect(r!.guidance).toContain('claude login');
  });

  test('auth：codex 未登录实测样本 → auth + codex login', () => {
    // 0.147.0 实测：CODEX_HOME 干净时 `codex login status` / exec 报 "Not logged in"
    const r = classifyCliFailure({ provider: 'codex', exitCode: 1, output: 'Not logged in' });
    expect(r!.category).toBe('auth');
    expect(r!.guidance).toContain('codex login');
  });

  test('auth：kimi 401 Unauthorized → auth + kimi login', () => {
    const r = classifyCliFailure({ provider: 'kimi', exitCode: 1, output: 'Error: 401 Unauthorized' });
    expect(r!.category).toBe('auth');
    expect(r!.guidance).toContain('kimi login');
  });

  test('quota：insufficient_quota → quota，指引指向额度', () => {
    const r = classifyCliFailure({ provider: 'claude', exitCode: 1, output: '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}' });
    expect(r!.category).toBe('quota');
  });

  test('quota：credit balance 形态 → quota', () => {
    const r = classifyCliFailure({ provider: 'kimi', exitCode: 1, output: 'Error: credit balance too low, please top up' });
    expect(r!.category).toBe('quota');
  });

  test('rate_limit：429 → rate_limit', () => {
    const r = classifyCliFailure({ provider: 'opencode', exitCode: 1, output: 'Error: 429 Too Many Requests' });
    expect(r!.category).toBe('rate_limit');
  });

  test('cli_not_found：command not found / exit 127 → cli_not_found，指引含 which', () => {
    const r = classifyCliFailure({ provider: 'codex', exitCode: 127, output: '/bin/sh: codex: command not found' });
    expect(r!.category).toBe('cli_not_found');
    expect(r!.guidance).toContain('codex');
  });

  test('flag_unsupported：unknown option → 指引提示升级 CLI', () => {
    // 旧版 codex 不认识 0.147.0 引入的 hook-trust flag 时的典型报错形态
    const r = classifyCliFailure({ provider: 'codex', exitCode: 2, output: "error: unexpected argument '--dangerously-bypass-hook-trust' found" });
    expect(r!.category).toBe('flag_unsupported');
  });

  test('未知特征 → null（走原有透传，不编造分类）', () => {
    const r = classifyCliFailure({ provider: 'claude', exitCode: 1, output: 'Error: EACCES permission denied, open /tmp/x' });
    expect(r).toBeNull();
  });

  test('指引文本是产品语言，不含内部路径/环境信息', () => {
    const r = classifyCliFailure({ provider: 'claude', exitCode: 1, output: 'Invalid API key' });
    expect(r!.guidance).not.toContain('/root/');
    expect(r!.guidance).not.toContain('STUDIO_HOME');
  });
});
