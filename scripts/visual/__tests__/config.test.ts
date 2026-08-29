import { describe, it, expect } from 'vitest';
import { PAGES, WIDTHS, shotFileName, RUNS_DIR } from '../config';

describe('visual config', () => {
  it('覆盖 #379 基线 12 页', () => {
    expect(PAGES).toHaveLength(12);
    expect(PAGES.map(p => p.path)).toEqual([
      '/channels',
      '/channels/:channelId',
      '/pmo',
      '/pmo/project/:pmoId',
      '/workunits',
      '/workunits/:workUnitId',
      '/agents',
      '/agents/:agentProfileId',
      '/monitoring',
      '/knowledge',
      '/library',
      '/settings',
    ]);
  });

  it('三档宽度 1920/1440/1280', () => {
    expect([...WIDTHS]).toEqual([1920, 1440, 1280]);
  });

  it('每页有唯一 name 且带参页声明了 param', () => {
    const names = PAGES.map(p => p.name);
    expect(new Set(names).size).toBe(PAGES.length);
    for (const p of PAGES) {
      const hasParam = p.path.includes(':');
      expect(hasParam ? p.param : p.param === undefined).toBeTruthy();
    }
  });

  it('shotFileName 生成 <page>-<width>.png', () => {
    expect(shotFileName('channels', 1920)).toBe('channels-1920.png');
  });

  it('截图 run 目录在 gitignored 的 .studio 下', () => {
    expect(RUNS_DIR).toContain('.studio');
  });
});
