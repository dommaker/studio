// 导航组件导入测试
import { describe, it, expect } from 'vitest';

describe('MR-007 导航组件导入', () => {
  it('TopNav 应能正常导入', async () => {
    const { TopNav } = await import('../TopNav');
    expect(TopNav).toBeDefined();
    expect(typeof TopNav).toBe('function');
  });

  it('MoreDropdown 应能正常导入', async () => {
    const { MoreDropdown } = await import('../MoreDropdown');
    expect(MoreDropdown).toBeDefined();
    expect(typeof MoreDropdown).toBe('function');
  });

  it('SidebarNew 应能正常导入', async () => {
    const { Sidebar } = await import('../SidebarNew');
    expect(Sidebar).toBeDefined();
    expect(typeof Sidebar).toBe('function');
  });
});