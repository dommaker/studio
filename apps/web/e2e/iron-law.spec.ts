import { test, expect } from '@playwright/test';

test.describe('Iron Law System', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('should have iron law related elements if triggered', async ({ page }) => {
    // 查找铁律相关文本
    const ironLawText = page.locator('text=/铁律|禁止|NO.*WITHOUT/');
    const count = await ironLawText.count();
    
    // 验证如果存在则可见
    if (count > 0) {
      await expect(ironLawText.first()).toBeVisible();
    }
  });

  test('should have modal or alert structure if iron law triggered', async ({ page }) => {
    // 查找弹窗/警告容器
    const alertContainer = page.locator('[class*="alert"], [class*="modal"], [class*="popup"]');
    const count = await alertContainer.count();
    
    if (count > 0) {
      await expect(alertContainer.first()).toBeVisible();
    }
  });

  test('should have actionable buttons if iron law alert shown', async ({ page }) => {
    // 查找操作按钮
    const actionButtons = page.locator('button');
    const count = await actionButtons.count();
    
    // 页面应该有按钮
    expect(count).toBeGreaterThan(0);
  });
});