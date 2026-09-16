/**
 * first-run-panel.ts 单元测试（#571：studio run web 首启检测块）。
 *
 * 冻结内容（data-directory-contract.md §7）：Node 版本（对 engines >=20）、
 * agent CLI 探测结果（provider/path/version）、数据根位置、实际监听地址；
 * 缺失 CLI 不阻断，但标注「至少需要一个 agent CLI 才能跑执行」。
 */
import { describe, it, expect } from 'vitest';
import { buildFirstRunPanel } from '../first-run-panel.js';

const base = {
  nodeVersion: 'v22.22.0',
  minNodeMajor: 20,
  providers: [
    { provider: 'claude' as const, path: '/usr/local/bin/claude', version: '1.0.0' },
    { provider: 'kimi' as const, path: '/usr/local/bin/kimi', version: '2.0.0' },
  ],
  dataRoot: '/home/u/.studio',
  listenHost: '127.0.0.1',
  listenPort: 3001,
  shiftedFrom: null as number | null,
};

describe('buildFirstRunPanel', () => {
  it('包含 Node 版本、provider 清单、数据根与监听地址', () => {
    const panel = buildFirstRunPanel(base);
    expect(panel).toContain('v22.22.0');
    expect(panel).toContain('claude');
    expect(panel).toContain('/usr/local/bin/claude');
    expect(panel).toContain('kimi');
    expect(panel).toContain('/home/u/.studio');
    expect(panel).toContain('127.0.0.1:3001');
  });

  it('Node 版本低于下限 → 面板标注不满足 engines', () => {
    const panel = buildFirstRunPanel({ ...base, nodeVersion: 'v18.19.0' });
    expect(panel).toMatch(/v18\.19\.0.*(below|require|>= ?20)/i);
  });

  it('Node 版本达标 → 不告警', () => {
    const panel = buildFirstRunPanel(base);
    expect(panel).not.toMatch(/v22\.22\.0.*below/i);
  });

  it('零 provider → 标注至少需要一个 agent CLI（不阻断语义，仅文案）', () => {
    const panel = buildFirstRunPanel({ ...base, providers: [] });
    expect(panel).toMatch(/至少需要一个 agent CLI|at least one agent CLI/i);
  });

  it('有 provider → 不出现缺 CLI 提示', () => {
    const panel = buildFirstRunPanel(base);
    expect(panel).not.toMatch(/at least one agent CLI/i);
  });

  it('端口顺延 → 标明实际端口与原首选', () => {
    const panel = buildFirstRunPanel({ ...base, listenPort: 3002, shiftedFrom: 3001 });
    expect(panel).toContain('127.0.0.1:3002');
    expect(panel).toContain('3001');
    expect(panel).toMatch(/shift|顺延|in use/i);
  });
});
