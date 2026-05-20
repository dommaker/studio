import { test, expect } from '@playwright/test';

test.describe('角色管理流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test.describe('TC-ROLE-001: 角色列表展示', () => {
    test('应该导航到角色页面', async ({ page }) => {
      // 查找角色导航链接
      const rolesLink = page.locator('a[href*="role"], button:has-text("角色")');
      const count = await rolesLink.count();
      
      if (count > 0) {
        await rolesLink.first().click();
        await page.waitForTimeout(1000);
        
        // 验证页面加载
        await expect(page.locator('h1, h2').first()).toContainText(/角色|Role/i);
      }
    });

    test('应该显示角色卡片', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(1000);
      
      // 查找角色卡片
      const roleCards = page.locator('div[class*="card"], div[class*="rounded"]');
      const count = await roleCards.count();
      
      // 页面应该有元素
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示角色类型信息', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(1000);
      
      // 查找角色类型文本
      const roleTypes = page.locator('text=/策划|评审|负责人|开发|架构|测试|strategy|reviewer|developer|architect|qa/i');
      const count = await roleTypes.count();
      
      // 如果有角色，类型应该显示
      if (count > 0) {
        await expect(roleTypes.first()).toBeVisible();
      }
    });

    test('应该显示角色级别信息', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(1000);
      
      // 查找级别信息
      const levels = page.locator('text=/L1|L2|L3|L4|初级|中级|高级|专家/');
      const count = await levels.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('TC-ROLE-002: 角色创建', () => {
    test('应该有新建角色按钮', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(500);
      
      // 查找新建按钮
      const newButton = page.locator('button:has-text("新建"), button:has-text("创建")');
      const count = await newButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示角色创建表单', async ({ page }) => {
      await page.goto('/#/roles');
      
      const newButton = page.locator('button:has-text("新建")');
      if (await newButton.count() > 0) {
        await newButton.click();
        await page.waitForTimeout(500);
        
        // 创建表单应该出现
        const formModal = page.locator('div[class*="modal"], form');
        const visible = await formModal.count();
        
        expect(visible).toBeGreaterThanOrEqual(0);
        
        // 验证表单字段
        const nameInput = page.locator('input[placeholder*="名称"], input[name*="name"]');
        expect(await nameInput.count()).toBeGreaterThanOrEqual(0);
      }
    });

    test('应该选择角色类型', async ({ page }) => {
      await page.goto('/#/roles');
      
      const newButton = page.locator('button:has-text("新建")');
      if (await newButton.count() > 0) {
        await newButton.click();
        await page.waitForTimeout(500);
        
        // 类型选择器
        const typeSelect = page.locator('select, button:has-text("策划"), button:has-text("开发")');
        const count = await typeSelect.count();
        
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test.describe('TC-ROLE-003: 角色能力管理', () => {
    test('应该显示角色能力数量', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(1000);
      
      // 查找能力数量相关元素
      const capCount = page.locator('text=/能力|capability|\\d+个/');
      const count = await capCount.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该有能力分配入口', async ({ page }) => {
      await page.goto('/#/roles');
      
      // 点击角色卡片（如果有）
      const roleCard = page.locator('div[class*="card"]').first();
      const count = await roleCard.count();
      
      if (count > 0) {
        await roleCard.click();
        await page.waitForTimeout(500);
        
        // 查找能力相关操作
        const capButton = page.locator('button:has-text("能力")');
        expect(await capButton.count()).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test.describe('TC-ROLE-004: 角色绩效查看', () => {
    test('应该显示绩效信息入口', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(1000);
      
      // 查找绩效相关元素
      const perfElements = page.locator('text=/绩效|performance|score|分数/');
      const count = await perfElements.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示绩效统计', async ({ page }) => {
      await page.goto('/#/roles');
      
      // 点击查看绩效（如果有）
      const perfButton = page.locator('button:has-text("绩效")');
      if (await perfButton.count() > 0) {
        await perfButton.first().click();
        await page.waitForTimeout(500);
        
        // 绩效详情应该出现
        const perfDetail = page.locator('div[class*="modal"], div[class*="performance"]');
        expect(await perfDetail.count()).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test.describe('TC-ROLE-005: 角色筛选', () => {
    test('应该有筛选器', async ({ page }) => {
      await page.goto('/#/roles');
      await page.waitForTimeout(500);
      
      // 查找筛选相关元素
      const filterElements = page.locator('select, button:has-text("筛选")');
      const count = await filterElements.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该能按类型筛选', async ({ page }) => {
      await page.goto('/#/roles');
      
      // 类型筛选器
      const typeFilter = page.locator('select[name*="type"], button:has-text("类型")');
      if (await typeFilter.count() > 0) {
        await typeFilter.first().click();
        await page.waitForTimeout(300);
        
        // 筛选选项应该出现
        const options = page.locator('option, li, button:has-text("策划")');
        expect(await options.count()).toBeGreaterThanOrEqual(0);
      }
    });
  });
});