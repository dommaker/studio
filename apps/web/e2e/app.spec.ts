import { test, expect } from '@playwright/test';

test.describe('Agent Studio App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load homepage', async ({ page }) => {
    // 检查页面是否加载
    await expect(page).toHaveTitle(/Agent|Studio|OpenClaw/i);
  });

  test('should have navigation', async ({ page }) => {
    // 导航链接应该存在
    const navLinks = page.locator('a, button');
    const count = await navLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should show main content area', async ({ page }) => {
    // 主要内容区域
    const mainContent = page.locator('div, main, section').first();
    await expect(mainContent).toBeVisible();
  });

  test('should be responsive', async ({ page }) => {
    // 测试不同屏幕尺寸
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator('body')).toBeVisible();
    
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('body')).toBeVisible();
    
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.locator('body')).toBeVisible();
  });

  test('should handle navigation to tasks page', async ({ page }) => {
    // 尝试导航到任务页面
    const tasksLink = page.locator('a[href*="tasks"], button:has-text("任务")');
    const count = await tasksLink.count();
    
    if (count > 0) {
      await tasksLink.first().click();
      await page.waitForTimeout(500);
      await expect(page).toHaveURL(/tasks/);
    }
  });

  test('should handle navigation to workflows page', async ({ page }) => {
    // 尝试导航到工作流页面
    const workflowsLink = page.locator('a[href*="workflow"], button:has-text("工作流")');
    const count = await workflowsLink.count();
    
    if (count > 0) {
      await workflowsLink.first().click();
      await page.waitForTimeout(500);
    }
  });
});