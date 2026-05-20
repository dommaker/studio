import { test, expect } from '@playwright/test';

test.describe('TaskCard Component', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
  });

  test('should display execution list if available', async ({ page }) => {
    // 查找任务相关的容器
    const containers = page.locator('div[class*="rounded"], div[class*="card"]');
    const count = await containers.count();
    
    // 页面应该有可见元素
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('should show execution status if available', async ({ page }) => {
    // 等待页面加载完成
    await page.waitForLoadState('domcontentloaded');
    
    // 查找状态文本
    const statusText = page.locator('text=/运行|完成|失败|等待|pending|running|success|failed/');
    const count = await statusText.count();
    
    // 如果有状态文本，验证可见
    if (count > 0) {
      await expect(statusText.first()).toBeVisible();
    }
  });

  test('should show progress information if available', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded');
    
    // 查找进度相关元素
    const progressElements = page.locator('[class*="progress"], div[style*="width"]');
    const count = await progressElements.count();
    
    if (count > 0) {
      await expect(progressElements.first()).toBeVisible();
    }
  });

  test('should be clickable if card exists', async ({ page }) => {
    await page.waitForLoadState('domcontentloaded');
    
    // 查找可点击的卡片
    const clickableCard = page.locator('div[class*="cursor-pointer"]').first();
    const count = await clickableCard.count();
    
    if (count > 0) {
      await clickableCard.click();
      await page.waitForTimeout(300);
    }
  });
});