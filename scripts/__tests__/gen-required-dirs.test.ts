/**
 * gen-required-dirs — .harness/config.yml required_dirs 自动发现生成器测试（#694）
 *
 * collectRequiredDirs：按固定规则扫描源码根（packages 各包 src → bootstrap → modules 各模块 → web）
 * applyGenerated：重写 config.yml 标记段；兼作漂移自检（仓内真实 config 必须已是最新）
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectRequiredDirs, applyGenerated } from '../gen-required-dirs.mjs';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'scripts/__tests__/fixtures/required-dirs');

describe('collectRequiredDirs()', () => {
  it('按规则扫描：packages 各包 src → bootstrap → modules 各模块，结构序固定', () => {
    expect(collectRequiredDirs(FIXTURE)).toEqual([
      'packages/alpha/src',
      'packages/beta/src',
      'apps/api/src/bootstrap',
      'apps/api/src/modules/mod-a',
      'apps/api/src/modules/mod-b',
    ]);
  });

  it('apps/web/src 不入单（web CONTEXT.md 自 #693 住 apps/web/docs/，列旧路径会逼 sync-docs 重建模板替身）', () => {
    expect(collectRequiredDirs(FIXTURE)).not.toContain('apps/web/src');
  });
});

describe('applyGenerated()', () => {
  const CONFIG = [
    'preset: standard',
    'governance:',
    '  context_files:',
    '    enabled: true',
    '    # AUTO-GENERATED:required_dirs',
    '    required_dirs:',
    '      - stale/entry',
    '    # /AUTO-GENERATED:required_dirs',
    '',
  ].join('\n');

  it('替换标记段内容，段外原样保留', () => {
    const next = applyGenerated(CONFIG, ['packages/alpha/src', 'apps/web/src']);
    expect(next).toBe([
      'preset: standard',
      'governance:',
      '  context_files:',
      '    enabled: true',
      '    # AUTO-GENERATED:required_dirs',
      '    required_dirs:',
      '      - packages/alpha/src',
      '      - apps/web/src',
      '    # /AUTO-GENERATED:required_dirs',
      '',
    ].join('\n'));
  });

  it('已是最新 → 返回原文（幂等，--check 据此判漂移）', () => {
    const fresh = applyGenerated(CONFIG, ['packages/alpha/src', 'apps/web/src']);
    expect(applyGenerated(fresh, ['packages/alpha/src', 'apps/web/src'])).toBe(fresh);
  });

  it('缺标记 → 抛错（不认静默改写）', () => {
    expect(() => applyGenerated('preset: standard\n', [])).toThrow(/AUTO-GENERATED:required_dirs/);
  });
});

describe('仓内 config.yml 漂移自检', () => {
  it('.harness/config.yml 的 required_dirs 与自动发现一致', () => {
    const file = path.join(ROOT, '.harness/config.yml');
    const content = readFileSync(file, 'utf-8');
    const next = applyGenerated(content, collectRequiredDirs(ROOT));
    expect(
      next === content,
      'config.yml required_dirs 已腐化——运行 pnpm gen:required-dirs 重新生成',
    ).toBe(true);
  });
});
