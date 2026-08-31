import { describe, it, expect } from 'vitest';
import { PAGES, B_PAGES, WIDTHS, B_WIDTHS, shotFileName, RUNS_DIR } from '../config';

describe('visual config', () => {
  it('覆盖 #379 基线 12 页 + #400 补 A 档 4 页 + NotFound', () => {
    expect(PAGES).toHaveLength(17);
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
      '/audit-logs',
      '/library/:libraryDocId',
      '/workspaces/:workspaceId',
      '/setup/roles',
      '/no-such-page-visual-check',
    ]);
  });

  it('B 档未认证页 4 页（spec §10.2；登录弹框走 landing 交互态，NotFound 需认证归 A 档）', () => {
    expect(B_PAGES.map(p => p.path)).toEqual([
      '/',
      '/forgot-password',
      '/reset-password',
      '/auth/callback',
    ]);
    expect(B_PAGES.every(p => p.param === undefined)).toBe(true);
  });

  it('B 档两档宽度 1920/1440（spec §10.2）', () => {
    expect([...B_WIDTHS]).toEqual([1920, 1440]);
  });

  it('A/B 两档页面名全局唯一', () => {
    const names = [...PAGES, ...B_PAGES].map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
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
