import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// React 19's CJS dev build includes `act`; production build omits it.
// @testing-library/react needs `act` — ensure NODE_ENV is not "production".
process.env.NODE_ENV = 'test';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 10000,
    // react-markdown / remark-gfm 是 ESM-only，transform 耗时长；inline 预打包避免测试超时
    deps: {
      inline: ['react-markdown', 'remark-gfm'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
