/**
 * LCP 测量 CLI（#674）纯逻辑测试：parseLcpArgs + renderLcpMarkdown。
 * runLcp 全链路为 I/O 编排（隔离 API + vite preview + chromium），
 * 靠真实测量跑通验证（performance-baseline.md §9.2 的 5 轮实测即验证记录）。
 */

import { describe, it, expect } from 'vitest';
import { parseLcpArgs, renderLcpMarkdown, type LcpReport } from '../lcp.js';

describe('parseLcpArgs', () => {
  it('缺省 runs=5', () => {
    expect(parseLcpArgs([])).toEqual({ runs: 5 });
  });

  it('解析 --runs / --out', () => {
    expect(parseLcpArgs(['--runs', '3', '--out', '/tmp/lcp.json'])).toEqual({ runs: 3, out: '/tmp/lcp.json' });
  });

  it('未知参数抛错', () => {
    expect(() => parseLcpArgs(['--bogus'])).toThrow('未知参数');
  });
});

describe('renderLcpMarkdown', () => {
  const report: LcpReport = {
    date: '2026-10-08',
    commit: '8e415aa9',
    runs: [
      { run: 1, lcpMs: 672, url: 'http://127.0.0.1:4173/channels/abc' },
      { run: 2, lcpMs: 512, url: 'http://127.0.0.1:4173/channels/abc' },
    ],
    p50Ms: 592,
    maxMs: 672,
  };

  it('渲染轮次表与 p50/max 汇总，落点取 pathname', () => {
    const md = renderLcpMarkdown(report);
    expect(md).toContain('| run1 | 672 ms | /channels/abc |');
    expect(md).toContain('| run2 | 512 ms | /channels/abc |');
    expect(md).toContain('p50 592 ms / max 672 ms（目标 < 2000 ms）');
    expect(md).toContain('8e415aa9');
  });
});
