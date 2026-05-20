// PMO 模块 E2E 测试
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

test.describe('PMO 模块 E2E 测试', () => {
  
  test.beforeAll(async () => {
    // 确保前端服务运行
    // API 服务已在 3001 端口运行
  });

  test('AC-007: PMO 入口显示在 CompanyHall', async ({ page }) => {
    // 导航到首页
    await page.goto(BASE_URL);
    
    // 等待页面加载
    await page.waitForLoadState('domcontentloaded');
    
    // 检查 PMO 卡片是否存在
    const pmoCard = page.locator('text=PMO 管理');
    await expect(pmoCard).toBeVisible({ timeout: 10000 });
    
    // 检查 PMO 卡片描述
    const pmoDescription = page.locator('text=OKR + 项目组合');
    await expect(pmoDescription).toBeVisible();
    
    // 检查 PMO 卡片链接
    const pmoLink = page.locator('a[href="/pmo"]');
    await expect(pmoLink).toBeVisible();
  });

  test('AC-008: PMO 页面显示项目列表', async ({ page }) => {
    // 直接导航到 PMO 页面
    await page.goto(`${BASE_URL}/pmo`);
    
    // 等待页面加载
    await page.waitForLoadState('domcontentloaded');
    
    // 检查页面标题
    const pageTitle = page.locator('text=PMO 管理');
    await expect(pageTitle).toBeVisible({ timeout: 10000 });
    
    // 检查项目 tab
    const projectsTab = page.locator('text=📁 项目');
    await expect(projectsTab).toBeVisible();
    
    // 检查 OKR tab
    const okrTab = page.locator('text=🎯 OKR');
    await expect(okrTab).toBeVisible();
    
    // 点击项目 tab
    await projectsTab.click();
    
    // 检查项目列表区域
    const projectList = page.locator('[class*="overflow-auto"]');
    await expect(projectList).toBeVisible();
  });

  test('AC-010: OKR 进度显示正确', async ({ page }) => {
    // 导航到 PMO 页面
    await page.goto(`${BASE_URL}/pmo`);
    
    // 点击 OKR tab
    const okrTab = page.locator('text=🎯 OKR');
    await okrTab.click();
    
    // 检查空状态或 OKR 列表
    const content = page.locator('[class*="overflow-auto"]');
    await expect(content).toBeVisible();
    
    // 检查"暂无 OKR"或 OKR 进度显示
    const emptyState = page.locator('text=暂无 OKR');
    const okrProgress = page.locator('text=进度');
    
    // 应该显示其中之一
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    const hasProgress = await okrProgress.isVisible().catch(() => false);
    
    expect(hasEmpty || hasProgress).toBeTruthy();
  });
});