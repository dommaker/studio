import { defineWorkspace } from 'vitest/config';

const baseExclude = ['**/node_modules/**', '**/*.spec.ts', '**/e2e/**', '**/*.e2e.test.ts', '**/trigger-eval.test.ts'];
const baseTest = { globals: true, environment: 'node' as const, pool: 'forks' as const };

export default defineWorkspace([
  // 根目录测试（含 E2E - globalSetup 启动 API server）
  {
    test: {
      ...baseTest,
      include: ['tests/**/*.test.ts'],
      exclude: ['tests/frontend/**', ...baseExclude],
      globalSetup: ['./tests/globalSetup.ts'],
    },
  },
  // packages 测试
  {
    test: {
      ...baseTest,
      include: ['packages/**/src/**/*.test.ts'],
      exclude: baseExclude,
    },
  },
  // apps/web 组件测试（jsdom）
  {
    test: {
      globals: true,
      include: ['apps/web/src/**/*.test.{ts,tsx}'],
      exclude: baseExclude,
      environment: 'jsdom',
      setupFiles: ['./apps/web/src/test/setup.ts'],
    },
    esbuild: { jsx: 'automatic' },
  },
  // apps/api 测试（排除 daemon - 需 Claude CLI + git worktree）
  {
    test: {
      ...baseTest,
      include: ['apps/api/src/**/*.test.ts'],
      exclude: ['apps/api/src/daemon/**', ...baseExclude],
      globalSetup: ['./tests/globalSetup.ts'],
      setupFiles: ['./apps/api/tests/setup-db.ts'],
    },
  },
  // daemon 测试（mocked - 不需要 Claude CLI）
  {
    test: {
      ...baseTest,
      include: ['apps/api/src/daemon/__tests__/**/*.test.ts'],
      exclude: baseExclude,
    },
  },
  // apps tests/ 目录
  {
    test: {
      ...baseTest,
      include: ['apps/**/tests/**/*.test.ts'],
      exclude: baseExclude,
      globalSetup: ['./tests/globalSetup.ts'],
      setupFiles: ['./apps/api/tests/setup-db.ts'],
    },
  },
  // scripts 测试
  {
    test: {
      ...baseTest,
      include: ['scripts/__tests__/**/*.test.ts'],
      exclude: baseExclude,
    },
  },
]);
