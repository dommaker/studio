// useDetectedProviders — 运行环境 CLI 探测 hook（2026-07 频道角色修复）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockGet } = vi.hoisted(() => ({
  mockGet: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockGet },
}));

import { useDetectedProviders, buildProviderOptions } from '../useDetectedProviders';

// ── buildProviderOptions (纯函数) ──

describe('buildProviderOptions', () => {
  it('回退模式：一未检测到则全部内置可选', () => {
    const opts = buildProviderOptions([], true);
    expect(opts).toHaveLength(4);
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('标记已检测到的内置 provider 为可选（带版本）', () => {
    const opts = buildProviderOptions([{ provider: 'claude', version: '2.0.0' }], false);
    const claude = opts.find((o) => o.value === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.disabled).toBe(false);
    expect(claude!.label).toContain('claude');
    expect(claude!.label).toContain('2.0.0');
  });

  it('未检测到的内置 provider 标灰禁用', () => {
    const opts = buildProviderOptions([], false);
    expect(opts).toHaveLength(4);
    expect(opts.every((o) => o.disabled)).toBe(true);
    const labels = opts.map((o) => o.label);
    expect(labels.every((l) => l.includes('未检测到'))).toBe(true);
  });

  it('保持输入顺序（排序由 useDetectedProviders hook 负责）', () => {
    const opts = buildProviderOptions([
      { provider: 'claude', version: '2.0.0' },
      { provider: 'a-tool', version: '1.0.0' },
      { provider: 'z-custom', version: '1.0.0' },
    ], false);
    const values = opts.filter((o) => !o.disabled).map((o) => o.value);
    expect(values).toEqual(['claude', 'a-tool', 'z-custom']);
  });

  // #565 AC4：auth=failed 标徽标 + hint；unknown 不标
  it('auth=failed 的 provider 带未登录徽标与修复 hint', () => {
    const opts = buildProviderOptions([
      { provider: 'codex', version: '0.147.0', auth: 'failed', authHint: '运行 codex login 登录' },
    ], false);
    const codex = opts.find((o) => o.value === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.label).toContain('未登录');
    expect(codex!.title).toBe('运行 codex login 登录');
    expect(codex!.auth).toBe('failed');
    expect(codex!.disabled).toBe(false);
  });

  it('auth=ok / unknown 不标徽标', () => {
    const opts = buildProviderOptions([
      { provider: 'claude', version: '2.1.273', auth: 'ok' },
      { provider: 'kimi', version: '0.38.0', auth: 'unknown' },
    ], false);
    expect(opts.find((o) => o.value === 'claude')!.label).not.toContain('未登录');
    expect(opts.find((o) => o.value === 'kimi')!.label).not.toContain('未登录');
  });
});

// ── useDetectedProviders (hook) ──

describe('useDetectedProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('初始 loading=true', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // 永不 resolve
    const { result } = renderHook(() => useDetectedProviders());
    expect(result.current.loading).toBe(true);
    expect(result.current.noneDetected).toBe(false);
  });

  it('API 成功返回后解析 provider 列表', async () => {
    mockGet.mockResolvedValue({
      data: {
        runtimes: [
          { provider: 'claude', version: '1.0.0' },
          { provider: 'kimi', version: '2.1.0' },
        ],
      },
    });
    const { result } = renderHook(() => useDetectedProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detected).toHaveLength(2);
    expect(result.current.detected[0].provider).toBe('claude');
    expect(result.current.detected[1].provider).toBe('kimi');
    expect(result.current.noneDetected).toBe(false);
  });

  it('API 失败时返回空 detected + noneDetected', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useDetectedProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detected).toHaveLength(0);
    expect(result.current.noneDetected).toBe(true);
  });

  it('清单内同 provider 重复条目只保留首次出现', async () => {
    mockGet.mockResolvedValue({
      data: {
        runtimes: [
          { provider: 'claude', version: 'v1' },
          { provider: 'claude', version: 'v2' },
        ],
      },
    });
    const { result } = renderHook(() => useDetectedProviders());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detected).toHaveLength(1);
    expect(result.current.detected[0].version).toBe('v1');
  });

  it('cancelled 卸载后忽略异步结果', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockGet.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useDetectedProviders());
    unmount();
    resolve({ data: { runtimes: [{ provider: 'claude', version: '1.0.0' }] } });
    // 状态应停留在初始值（loading=true, no crash）
    expect(result.current.loading).toBe(true);
  });

  it('enabled=false 不发起请求，loading 保持 true（#403 懒挂载）', () => {
    mockGet.mockReturnValue(new Promise(() => {})); // 永不 resolve
    const { result } = renderHook(() => useDetectedProviders({ enabled: false }));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
    expect(result.current.noneDetected).toBe(false);
  });

  it('enabled 翻 true 后发起且每次挂载只扫一次；收起再展开不重发（#403）', async () => {
    mockGet.mockResolvedValue({
      data: { runtimes: [{ provider: 'claude', version: '1.0.0' }] },
    });
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDetectedProviders({ enabled }),
      { initialProps: { enabled: false } },
    );
    expect(mockGet).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detected).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    // 面板收起再展开：不重发（结果已在本地态）
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result.current.detected).toHaveLength(1);
  });
});
