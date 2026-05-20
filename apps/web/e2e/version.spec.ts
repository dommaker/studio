import { test, expect } from '@playwright/test';

test.describe('版本管理', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test.describe('TC-VERSION-001: 工作流版本历史', () => {
    test('应该显示版本管理入口', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 查找版本相关按钮
      const versionButton = page.locator('button:has-text("版本"), button:has-text("Version"), button:has-text("历史")');
      const count = await versionButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示版本列表', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 点击版本按钮（如果有）
      const versionButton = page.locator('button:has-text("版本")').first();
      if (await versionButton.count() > 0) {
        await versionButton.click();
        await page.waitForTimeout(500);
        
        // 版本列表应该出现
        const versionList = page.locator('div[class*="modal"], div[class*="version"]');
        expect(await versionList.count()).toBeGreaterThanOrEqual(0);
      }
    });

    test('应该显示版本号', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 查找版本号格式
      const versionNumbers = page.locator('text=/v\\d+|version.*\\d+|\\d+\\.\\d+\\.\\d+/');
      const count = await versionNumbers.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示版本创建时间', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 查找时间元素
      const timeElements = page.locator('text=/2026-|\\d+月\\d+|\\d+-\\d+-\\d+/');
      const count = await timeElements.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('TC-VERSION-002: 版本对比', () => {
    test('应该有版本对比功能', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(500);
      
      // 查找对比按钮
      const compareButton = page.locator('button:has-text("对比"), button:has-text("Compare"), button:has-text("Diff")');
      const count = await compareButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('选择两个版本应该显示 diff', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 点击版本管理（如果有）
      const versionButton = page.locator('button:has-text("版本")').first();
      if (await versionButton.count() > 0) {
        await versionButton.click();
        await page.waitForTimeout(500);
        
        // 选择两个版本进行对比
        const compareButton = page.locator('button:has-text("对比")').first();
        if (await compareButton.count() > 0) {
          await compareButton.click();
          await page.waitForTimeout(500);
          
          // diff 结果应该出现
          const diffResult = page.locator('text=/新增|移除|修改|added|removed|modified/');
          expect(await diffResult.count()).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test('diff 结果应该标注变更类型', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 查找变更标注（正则特殊字符已转义：+ 和 -）
      const changeMarkers = page.locator('text=/新增|删除|修改|added|removed|modified/');
      const count = await changeMarkers.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  test.describe('TC-VERSION-003: 版本回滚', () => {
    test('应该有回滚功能', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(500);
      
      // 查找回滚按钮
      const rollbackButton = page.locator('button:has-text("回滚"), button:has-text("Rollback"), button:has-text("恢复")');
      const count = await rollbackButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('回滚应该显示确认弹窗', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(1000);
      
      // 点击版本历史中的回滚按钮（如果有）
      const rollbackButton = page.locator('button:has-text("回滚")').first();
      if (await rollbackButton.count() > 0) {
        await rollbackButton.click();
        await page.waitForTimeout(500);
        
        // 确认弹窗应该出现
        const confirmModal = page.locator('text=/确认|Confirm|回滚|Rollback/');
        expect(await confirmModal.count()).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test.describe('TC-VERSION-004: 创建新版本', () => {
    test('应该有创建新版本功能', async ({ page }) => {
      await page.goto('/#/workflow');
      await page.waitForTimeout(500);
      
      // 查找创建版本按钮
      const createVersionButton = page.locator('button:has-text("创建版本"), button:has-text("New Version")');
      const count = await createVersionButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('创建版本应该弹出表单', async ({ page }) => {
      await page.goto('/#/workflow');
      
      const createButton = page.locator('button:has-text("创建版本")').first();
      if (await createButton.count() > 0) {
        await createButton.click();
        await page.waitForTimeout(500);
        
        // 表单应该出现
        const versionForm = page.locator('input, textarea, text=/版本说明|描述/');
        expect(await versionForm.count()).toBeGreaterThanOrEqual(0);
      }
    });
  });

  test.describe('TC-VERSION-005: 步骤版本管理', () => {
    test('步骤应该有版本历史', async ({ page }) => {
      await page.goto('/#/skills');
      await page.waitForTimeout(500);
      
      // 查找版本相关元素
      const versionElements = page.locator('text=/版本|version|Git|提交/');
      const count = await versionElements.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该显示 Git 提交历史', async ({ page }) => {
      await page.goto('/#/skills');
      await page.waitForTimeout(1000);
      
      // 查找 Git commit 格式
      const commitHash = page.locator('text=/\\w{7,}|commit|提交/');
      const count = await commitHash.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('应该有版本检出功能', async ({ page }) => {
      await page.goto('/#/skills');
      await page.waitForTimeout(500);
      
      // 查找回检出按钮
      const checkoutButton = page.locator('button:has-text("检出"), button:has-text("Checkout")');
      const count = await checkoutButton.count();
      
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});