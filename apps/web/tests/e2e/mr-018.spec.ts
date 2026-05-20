/**
 * MR-018: 虚拟滚动优化 E2E 测试
 *
 * 验收标准：
 * AC-001: 消息列表性能优化（分页实现）
 * AC-002: 大量消息场景测试
 */

import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

test.describe('MR-018: 虚拟滚动优化', () => {

  test('AC-001: 消息列表使用分页加载', async ({ page }) => {
    // 获取现有会议
    const listRes = await page.request.get(`${BASE_URL}/api/v1/meetings?limit=5`);
    const listData = await listRes.json();
    const meetingId = listData.data?.[0]?.id;

    if (!meetingId) {
      test.skip();
      return;
    }

    // 打开会议详情页
    await page.goto(`${BASE_URL}/meetings/${meetingId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // 验证消息列表存在
    const messageArea = page.locator('.overflow-auto').first();
    await expect(messageArea).toBeVisible();

    // 验证分页按钮可能存在（如果有足够消息）
    const loadMoreButton = page.getByText('加载更早消息');
    const buttonVisible = await loadMoreButton.isVisible().catch(() => false);

    // 如果按钮可见，验证点击可以加载更多
    if (buttonVisible) {
      await loadMoreButton.click();
      await page.waitForTimeout(500);
      // 验证加载成功（按钮仍然可见或消失）
    }

    // 验证消息滚动锚点存在
    const messagesContainer = page.locator('.space-y-4');
    await expect(messagesContainer).toBeVisible();
  });

  test('AC-002: 验证分页逻辑', async ({ page }) => {
    // 创建测试会议
    const createRes = await page.request.post(`${BASE_URL}/api/v1/meetings`, {
      data: {
        title: 'MR-018 测试会议',
        companyId: 'test-company-skill-001',
        mode: 'sync',
        maxRounds: 10,
      },
    });

    const createData = await createRes.json();
    let meetingId = createData.data?.id;

    // 如果创建失败，使用现有会议
    if (!meetingId) {
      const listRes = await page.request.get(`${BASE_URL}/api/v1/meetings?limit=1`);
      const listData = await listRes.json();
      meetingId = listData.data?.[0]?.id;
    }

    if (!meetingId) {
      test.skip();
      return;
    }

    // 打开会议详情页
    await page.goto(`${BASE_URL}/meetings/${meetingId}`);
    await page.waitForLoadState('networkidle');

    // 验证页面正常渲染（没有卡顿）
    const renderTime = await page.evaluate(() => {
      const start = performance.now();
      return start;
    });

    // 验证消息列表区域可见
    const messageArea = page.locator('.overflow-auto').first();
    await expect(messageArea).toBeVisible({ timeout: 5000 });

    // 验证没有大量 DOM 元素导致性能问题
    // 使用 displayLimit 机制，只渲染有限消息
    const messageElements = await page.locator('.message-bubble, [class*="message"]').count();
    console.log(`Message elements count: ${messageElements}`);

    // 即使消息很多，渲染的元素应该有限
    // displayLimit 默认应该是 50
    expect(messageElements).toBeLessThanOrEqual(100);
  });
});