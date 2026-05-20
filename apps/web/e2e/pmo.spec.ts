// PMO 模块 E2E 测试
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

test.describe('PMO 模块 E2E 测试', () => {
  
  test('AC-007: PMO 入口显示在 CompanyHall', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('domcontentloaded');
    
    // 等待 React 应用加载完成
    await page.waitForTimeout(3000);
    
    // 使用 getByText 匹配 "PMO 管理"（因为 CompanyHallCard 的标题是 div，不是 heading）
    const pmoCard = page.locator('text=PMO 管理');
    
    // 截图保存
    await page.screenshot({ path: 'test-results/homepage.png', fullPage: true });
    
    // 验证：PMO 卡片存在
    expect(await pmoCard.count()).toBeGreaterThan(0);
    
    // 验证：PMO 卡片描述正确
    const pmoDescription = page.locator('text=OKR + 项目组合');
    expect(await pmoDescription.count()).toBeGreaterThan(0);
  });

  test('AC-008: PMO 页面显示项目列表', async ({ page }) => {
    await page.goto(`${BASE_URL}/pmo`);
    await page.waitForLoadState('domcontentloaded');
    
    // 等待 React 应用加载完成
    await page.waitForTimeout(3000);
    
    // 截图保存
    await page.screenshot({ path: 'test-results/pmo-page.png', fullPage: true });
    
    // 检查页面标题（使用 getByText，因为可能不是 heading 元素）
    const pageTitle = page.locator('text=PMO 管理');
    expect(await pageTitle.count()).toBeGreaterThan(0);
    
    // 检查项目 tab
    const projectsTab = page.locator('text=项目');
    expect(await projectsTab.count()).toBeGreaterThan(0);
    
    // 检查 OKR tab
    const okrTab = page.locator('text=OKR');
    expect(await okrTab.count()).toBeGreaterThan(0);
    
    // 检查 PMO 号显示（PM-001, PM-002 等）
    const pmoNumbers = page.locator('text=PM-');
    const count = await pmoNumbers.count();
    
    // 验证：有项目显示（至少一个 PMO 号）
    expect(count).toBeGreaterThan(0);
  });

  test('AC-010: OKR 进度显示正确', async ({ page }) => {
    await page.goto(`${BASE_URL}/pmo`);
    await page.waitForLoadState('domcontentloaded');
    
    // 点击 OKR tab
    const okrTab = page.getByRole('button', { name: 'OKR' });
    await okrTab.click();
    
    // 截图保存
    await page.screenshot({ path: 'test-results/pmo-okr-tab.png', fullPage: true });
    
    // 检查空状态或 OKR 进度
    const emptyState = page.getByText('暂无 OKR');
    const okrProgress = page.getByText(/\d+%$/);
    
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    const hasProgress = await okrProgress.isVisible().catch(() => false);
    
    expect(hasEmpty || hasProgress).toBeTruthy();
  });
});