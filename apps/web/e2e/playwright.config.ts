import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: 'http://localhost:5180',
    headless: true,
  },
  timeout: 60000,
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'e2e',
      testMatch: /channel-e2e\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        storageState: 'e2e/.auth.json',
      },
    },
  ],
});
