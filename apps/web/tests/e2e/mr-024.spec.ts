/**
 * MR-024: 会议导入文档功能 E2E 测试
 *
 * AC-001: 前端有"导入议题"按钮
 * AC-002: 点击按钮弹出文档选择器
 * AC-004: 选择任务后自动填充 title/description
 */

import { test, expect } from '@playwright/test';

const FRONTEND_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:13101/api/v1';

test.describe('MR-024: 会议导入文档功能', () => {
  test.beforeEach(async ({ page }) => {
    // 导航到会议列表页
    await page.goto(`${FRONTEND_URL}/meetings`);
    await page.waitForLoadState('networkidle');
  });

  test('AC-001: 前端有"导入议题"按钮', async ({ page }) => {
    // 点击"创建会议"按钮
    const createButton = page.getByText('创建会议', { exact: false });
    await createButton.click();

    // 等待弹窗出现
    await page.waitForSelector('text=创建新会议');

    // 检查"导入议题"按钮是否存在
    const importButton = page.getByText('导入议题');
    await expect(importButton).toBeVisible();
  });

  test('AC-002: 点击按钮弹出文档选择器', async ({ page }) => {
    // 点击"创建会议"按钮
    await page.getByText('创建会议', { exact: false }).click();
    await page.waitForSelector('text=创建新会议');

    // 点击"导入议题"按钮
    await page.getByText('导入议题').click();

    // 检查导入弹窗是否出现
    await expect(page.getByText('📥 导入议题')).toBeVisible();

    // 检查两种导入方式
    await expect(page.getByText('粘贴文本')).toBeVisible();
    await expect(page.getByText('从 URL 导入')).toBeVisible();
  });

  test('AC-003: 解析 roadmap 任务列表', async ({ page }) => {
    // 测试用的 roadmap 内容
    const roadmapContent = `
| ID | 任务 | 优先级 | 状态 | 说明 |
|------|------|:-----:|:----:|------|
| MR-024 | 会议导入文档功能 | P1 | ⬜ | 从 roadmap/文档导入议题 |
| MR-013 | 发言队列可视化 | P1 | ⬜ | 决策 #13 |
`;

    // 打开创建会议弹窗
    await page.getByText('创建会议', { exact: false }).click();
    await page.waitForSelector('text=创建新会议');

    // 点击"导入议题"
    await page.getByText('导入议题').click();
    await page.waitForSelector('text=📥 导入议题');

    // 确保选中"粘贴文本"
    await page.getByText('粘贴文本').click();

    // 输入 roadmap 内容
    const textarea = page.locator('textarea');
    await textarea.fill(roadmapContent);

    // 点击"解析文档"
    await page.getByText('解析文档').click();

    // 等待解析结果
    await page.waitForSelector('text=找到', { timeout: 5000 });

    // 检查解析的议题
    await expect(page.getByText('[MR-024]')).toBeVisible();
    await expect(page.getByText('[MR-013]')).toBeVisible();
  });

  test('AC-004: 选择任务后自动填充 title/description', async ({ page }) => {
    const roadmapContent = `
| MR-024 | 会议导入文档功能 | P1 | ⬜ | 从 roadmap/文档导入议题 |
`;

    // 打开创建会议弹窗
    await page.getByText('创建会议', { exact: false }).click();
    await page.waitForSelector('text=创建新会议');

    // 导入议题
    await page.getByText('导入议题').click();
    await page.locator('textarea').fill(roadmapContent);
    await page.getByText('解析文档').click();
    await page.waitForSelector('text=[MR-024]', { timeout: 5000 });

    // 点击选择议题
    await page.getByText('[MR-024]').click();

    // 导入弹窗应该关闭
    await expect(page.getByText('📥 导入议题')).not.toBeVisible();

    // 检查会议表单是否填充
    const titleInput = page.locator('input[type="text"]').first();
    const titleValue = await titleInput.inputValue();
    expect(titleValue).toContain('[MR-024]');
    expect(titleValue).toContain('会议导入文档功能');
  });

  test('API: POST /import-topic 解析正确', async () => {
    const roadmapContent = `
| ID | 任务 | 优先级 | 状态 | 说明 |
|------|------|:-----:|:----:|------|
| TEST-001 | 测试任务 | P1 | ⬜ | 测试说明 |
`;

    const res = await fetch(`${API_BASE}/meetings/import-topic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'text',
        text: roadmapContent,
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.topics.length).toBeGreaterThanOrEqual(1);
    expect(data.topics[0].id).toBe('TEST-001');
  });
});