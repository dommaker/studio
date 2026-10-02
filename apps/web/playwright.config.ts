import { defineConfig, devices } from '@playwright/test';

// E2E 主配置（P3-a 三份合一）：
// - 原 apps/web/playwright.config.ts（baseURL 5173，vite dev，UI smoke 全量 spec）
// - 原 apps/web/e2e/playwright.config.ts（baseURL 5180 + auth setup + channel-e2e 全链路）
// - 原 apps/web/e2e/playwright.local.config.ts（系统 Chrome fallback，未入库）
//   → 归并为 PW_USE_SYSTEM_CHROME=1 环境开关
//
// projects 区分场景：
//   ui          — 5173 vite dev 起服即可跑（CI 自动 webServer），跑全部 *.spec 除 channel-e2e
//   setup       — guest token 落 e2e/.auth.json（需 13001 API）
//   channel-e2e — 5180 + 13001 全栈，依赖 setup
// 跑法：pnpm e2e --project=ui（本地无全栈时）；全量需先起 5180/13001。

// 系统 Chrome fallback（ms-playwright 浏览器未安装时）：PW_USE_SYSTEM_CHROME=1
const systemChrome = process.env.PW_USE_SYSTEM_CHROME ? { channel: 'chrome' as const } : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60000,

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'ui',
      testMatch: /^(?!.*(auth\.setup|channel-e2e)).*\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], ...systemChrome, baseURL: 'http://localhost:5173' },
    },
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'channel-e2e',
      testMatch: /channel-e2e\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        ...systemChrome,
        baseURL: 'http://localhost:5180',
        headless: true,
        storageState: 'e2e/.auth.json',
      },
    },
  ],

  webServer: process.env.CI ? {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120000,
  } : undefined,
});
