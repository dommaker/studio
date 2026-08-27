/**
 * SystemExecutor 单元测试
 *
 * AC-1.6 ~ AC-1.10
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

// Mock @dommaker/studio-shared/node 的 execSh + provider helpers
const { mockExecSh } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
}));
const { mockResolveProvider } = vi.hoisted(() => ({
  mockResolveProvider: vi.fn(),
}));
const { mockBuildArgs } = vi.hoisted(() => ({
  mockBuildArgs: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
  resolveProviderDefinition: mockResolveProvider,
  buildArgsFromTemplate: mockBuildArgs,
  // F1: default-provider → cli-scanner 模块初始化需要（返回空 = 本测试不涉及 CLI 探测）
  listScanProviders: vi.fn(() => []),
}));

import { SystemExecutor, StudioRoleNotConfiguredError, SystemExecutorJsonParseError } from '../system-executor.js';
import { ensureStudioProfile } from '../agent-profile.service.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'system-executor-test-'));
}

describe('SystemExecutor', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let eventsFile: string;
  let executor: SystemExecutor;

  beforeEach(() => {
    tmpDir = createTempDir();
    fileStore = new FileStore(tmpDir);
    eventsFile = path.join(tmpDir, 'studio-events.jsonl');
    executor = new SystemExecutor(fileStore, eventsFile);

    // Default provider mock：claude provider
    mockResolveProvider.mockReturnValue({
      id: 'claude',
      displayName: 'Claude Code',
      binaries: ['claude'],
      spawn: { baseArgs: ['--print', '--output-format', '{outputFormat}'], defaultOutputFormat: 'json', promptViaStdin: true },
    });
    mockBuildArgs.mockReturnValue({
      args: ['--print', '--output-format', 'json'],
      promptViaStdin: true,
    });
    mockExecSh.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('AC-1.7 run()', () => {
    it('返回 SystemExecutorResult（output + usage + durationMs）', async () => {
      await ensureStudioProfile(fileStore);
      // 更新 studio 角色 provider=claude
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify({ result: 'hello', usage: { input_tokens: 100, output_tokens: 50 } }),
        stderr: '',
      });

      const result = await executor.run('test prompt');
      expect(result.output).toContain('hello');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('CLI 输出非 JSON 时 usage=undefined，output 返回原始 stdout', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: 'plain text output', stderr: '' });

      const result = await executor.run('test');
      expect(result.output).toBe('plain text output');
      expect(result.usage).toBeUndefined();
    });

    it('stream-json 数组输出时从末位 result 事件提取 usage（#364）', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'x' },
          { type: 'result', subtype: 'success', is_error: false, result: '{}', usage: { input_tokens: 10, output_tokens: 5 } },
        ]),
        stderr: '',
      });

      const result = await executor.run('test');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });
  });

  describe('AC-1.8 runJson<T>()', () => {
    it('解析 JSON 输出返回 T', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      const mockResult = { duplicates: [{ keep: 'id1', merge: ['id2'], reason: 'same' }] };
      mockExecSh.mockResolvedValue({ stdout: JSON.stringify(mockResult), stderr: '' });

      const result = await executor.runJson<{ duplicates: unknown[] }>('dedup prompt');
      expect(result.duplicates).toHaveLength(1);
      expect((result.duplicates[0] as { keep: string }).keep).toBe('id1');
    });

    it('claude --output-format json --verbose 输出为 stream-json 数组时，取末位 result 事件的 .result 解析', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      // 真实捕获形态（/tmp/e2e-351/claude-probe.json）：单行 JSON 数组，
      // 模型产出藏在末位 type=result 事件的 .result 字符串里
      const modelJson = JSON.stringify({ products: [{ title: 'P1' }] });
      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify([
          { type: 'system', subtype: 'init', session_id: 'x' },
          { type: 'assistant', message: { content: [{ type: 'text', text: modelJson }] } },
          { type: 'result', subtype: 'success', is_error: false, result: modelJson, usage: { input_tokens: 10, output_tokens: 5 } },
        ]),
        stderr: '',
      });

      const result = await executor.runJson<{ products: unknown[] }>('distill prompt');
      expect(result.products).toHaveLength(1);
    });

    it('单 result envelope 形态（claude 无 --verbose）同样解包 .result', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      // 真实捕获形态（/tmp/e2e-351/claude-probe4.json）：{type:"result", result:"<json>", usage:{…}}
      const modelJson = JSON.stringify({ products: [] });
      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: modelJson, usage: { input_tokens: 118, output_tokens: 47 } }),
        stderr: '',
      });

      const result = await executor.runJson<{ products: unknown[] }>('distill prompt');
      expect(result.products).toEqual([]);
    });

    it('stream-json 数组中无 result 事件时抛 SystemExecutorJsonParseError', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify([{ type: 'system', subtype: 'init', session_id: 'x' }]),
        stderr: '',
      });

      await expect(executor.runJson('prompt')).rejects.toBeInstanceOf(SystemExecutorJsonParseError);
    });

    it('JSON parse 失败抛 SystemExecutorJsonParseError（含 rawOutput）', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: 'not json {', stderr: '' });

      await expect(executor.runJson('bad prompt')).rejects.toBeInstanceOf(SystemExecutorJsonParseError);
      try {
        await executor.runJson('bad prompt');
      } catch (e) {
        expect((e as SystemExecutorJsonParseError).rawOutput).toBe('not json {');
      }
    });
  });

  describe('AC-1.7 provider=null 抛 StudioRoleNotConfiguredError', () => {
    it('studio 角色 provider=null 时抛 StudioRoleNotConfiguredError', async () => {
      await ensureStudioProfile(fileStore);
      // L2 后 seed 自带缺省 provider，显式清空以覆盖未配置路径
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: null });
      await expect(executor.run('test')).rejects.toBeInstanceOf(StudioRoleNotConfiguredError);
      expect(mockExecSh).not.toHaveBeenCalled();
    });
  });

  describe('AC-1.10 写 system:tokens 事件', () => {
    it('run 完成后写 system:tokens 事件到 studio-events.jsonl', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({
        stdout: JSON.stringify({ result: 'ok', usage: { input_tokens: 200, output_tokens: 100 } }),
        stderr: '',
      });

      await executor.run('test prompt');

      // 读 studio-events.jsonl 验证
      const content = fs.readFileSync(eventsFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const evt = JSON.parse(lines[lines.length - 1]);
      expect(evt.type).toBe('system:tokens');
      expect(evt.source).toBe('system-executor');
      const payload = JSON.parse(evt.payload);
      expect(payload.provider).toBe('claude');
      expect(payload.inputTokens).toBe(200);
      expect(payload.outputTokens).toBe(100);
      expect(payload.promptSignature).toBeDefined();
      expect(typeof payload.promptSignature).toBe('string');
      expect(payload.promptSignature).toHaveLength(8);
    });

    it('usage 缺失时 inputTokens/outputTokens 记 null 不编造', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: 'no json', stderr: '' });

      await executor.run('test');

      const content = fs.readFileSync(eventsFile, 'utf-8');
      const evt = JSON.parse(content.trim().split('\n').pop()!);
      const payload = JSON.parse(evt.payload);
      expect(payload.inputTokens).toBeNull();
      expect(payload.outputTokens).toBeNull();
    });
  });

  describe('AC-1.9 SystemExecutorOptions', () => {
    it('传 cwd 时作为 execSh 的 cwd', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('test', { cwd: '/tmp/test-cwd' });

      expect(mockExecSh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: '/tmp/test-cwd' }),
      );
    });

    it('env 注入 IS_SANDBOX=1（root guard 放行；host 已设则尊重 host）', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });
      const prev = process.env.IS_SANDBOX;
      delete process.env.IS_SANDBOX;
      try {
        await executor.run('test');
        expect(mockExecSh.mock.calls[0][1].env.IS_SANDBOX).toBe('1');

        process.env.IS_SANDBOX = 'host-value';
        mockExecSh.mockClear();
        await executor.run('test');
        expect(mockExecSh.mock.calls[0][1].env.IS_SANDBOX).toBe('host-value');
      } finally {
        if (prev === undefined) delete process.env.IS_SANDBOX;
        else process.env.IS_SANDBOX = prev;
      }
    });

    it('传 systemPrompt 时合并到 stdin（systemPrompt + prompt）', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('user prompt', { systemPrompt: 'system instruction' });

      const callArgs = mockExecSh.mock.calls[0][1];
      expect(callArgs.stdin).toContain('system instruction');
      expect(callArgs.stdin).toContain('user prompt');
    });

    it('默认 timeoutMs=30000', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('test');

      expect(mockExecSh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
    });

    // #369：按 eventSource 注册表解析默认超时
    it('eventSource 命中注册表时用表内默认超时（重 prompt 源 120s）', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('test', { eventSource: 'knowledge-maintenance' });

      expect(mockExecSh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
    });

    it('eventSource 未命中注册表时走 30s 默认', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('test', { eventSource: 'some-light-source' });

      expect(mockExecSh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
    });

    it('显式 timeoutMs 优先于注册表', async () => {
      await ensureStudioProfile(fileStore);
      const profiles = await fileStore.listProfiles();
      const studio = profiles.find(p => p.name === 'studio')!;
      await fileStore.updateProfile(studio.id, { provider: 'claude' });

      mockExecSh.mockResolvedValue({ stdout: '{}', stderr: '' });

      await executor.run('test', { eventSource: 'knowledge-distill', timeoutMs: 15_000 });

      expect(mockExecSh).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 15_000 }),
      );
    });
  });
});
