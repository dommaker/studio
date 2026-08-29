import { describe, it, expect } from 'vitest';
import { pairShots, classify, renderMarkdown, type DiffEntry } from '../report';

describe('pairShots', () => {
  it('按文件名配对两轮截图，缺失侧标注 missing', () => {
    const pairs = pairShots(
      ['channels-1920.png', 'pmo-1440.png'],
      ['channels-1920.png', 'settings-1280.png'],
    );
    expect(pairs).toEqual([
      { name: 'channels-1920.png', missing: undefined },
      { name: 'pmo-1440.png', missing: 'b' },
      { name: 'settings-1280.png', missing: 'a' },
    ]);
  });
});

describe('classify', () => {
  it('0 = clean，<1% = minor，>=1% = major', () => {
    expect(classify(0)).toBe('clean');
    expect(classify(0.009)).toBe('minor');
    expect(classify(0.01)).toBe('major');
  });
});

describe('renderMarkdown', () => {
  const entries: DiffEntry[] = [
    { file: 'channels-1920.png', page: 'channels', width: 1920, diffRatio: 0, diffPixels: 0, totalPixels: 1920 * 1080, status: 'clean' },
    { file: 'pmo-1440.png', page: 'pmo', width: 1440, diffRatio: 0.004, diffPixels: 5000, totalPixels: 1440 * 900, status: 'minor', diffImage: 'pmo-1440.diff.png' },
    { file: 'settings-1280.png', page: 'settings', width: 1280, diffRatio: 0.05, diffPixels: 60000, totalPixels: 1280 * 800, status: 'major', diffImage: 'settings-1280.diff.png' },
  ];

  it('产出 markdown 摘要：总计 + 逐页差异率表', () => {
    const md = renderMarkdown({ runA: 'a', runB: 'b', generatedAt: '2026-08-29', entries });
    expect(md).toContain('# 截图 diff 报告');
    expect(md).toContain('`a` vs `b`');
    expect(md).toContain('| 页面 | 宽度 | 差异率 | 像素数 | 状态 |');
    expect(md).toContain('| channels | 1920 | 0.00% | 0 | clean |');
    expect(md).toContain('| pmo | 1440 | 0.40% | 5000 | minor |');
    expect(md).toContain('| settings | 1280 | 5.00% | 60000 | major |');
  });

  it('差异页引用对比图，clean 页不引用', () => {
    const md = renderMarkdown({ runA: 'a', runB: 'b', generatedAt: '2026-08-29', entries });
    expect(md).toContain('![pmo-1440](pmo-1440.diff.png)');
    expect(md).toContain('![settings-1280](settings-1280.diff.png)');
    expect(md).not.toContain('channels-1920.diff.png');
  });

  it('缺失文件在报告中标注', () => {
    const md = renderMarkdown({
      runA: 'a', runB: 'b', generatedAt: '2026-08-29',
      entries: [{ file: 'x-1920.png', page: 'x', width: 1920, diffRatio: 0, diffPixels: 0, totalPixels: 0, status: 'missing-b' }],
    });
    expect(md).toContain('missing-b');
  });
});
