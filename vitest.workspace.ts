import { defineWorkspace } from 'vitest/config';

const baseExclude = ['**/node_modules/**', '**/*.spec.ts', '**/e2e/**', '**/*.e2e.test.ts'];

export default defineWorkspace([
  // 根目录测试（含 E2E — globalSetup 启动 API server）
  {
    test: {
      include: ['tests/**/*.test.ts'],
      exclude: ['tests/frontend/**', ...baseExclude],
      environment: 'node',
      globalSetup: ['./tests/globalSetup.ts'],
    },
  },
  // packages 测试
  {
    test: {
      include: ['packages/**/src/**/*.test.ts'],
      exclude: baseExclude,
      environment: 'node',
    },
  },
  // apps/web 组件测试（jsdom）
  {
    test: {
      include: ['apps/web/src/**/*.test.{ts,tsx}'],
      exclude: baseExclude,
      environment: 'jsdom',
      setupFiles: ['./apps/web/src/test/setup.ts'],
    },
    esbuild: { jsx: 'automatic' },
  },
  // apps/api 测试（排除 daemon — 需 Claude CLI + git worktree）
  {
    test: {
      include: ['apps/api/src/**/*.test.ts'],
      exclude: ['apps/api/src/daemon/**', ...baseExclude],
      environment: 'node',
      globalSetup: ['./tests/globalSetup.ts'],
      setupFiles: ['./apps/api/tests/setup-db.ts'],
    },
  },
  // daemon 测试（mocked — 不需要 Claude CLI）
  {
    test: {
      include: ['apps/api/src/daemon/__tests__/**/*.test.ts'],
      exclude: baseExclude,
      environment: 'node',
    },
  },
  // apps tests/ 目录
  {
    test: {
      include: ['apps/**/tests/**/*.test.ts'],
      exclude: baseExclude,
      environment: 'node',
      globalSetup: ['./tests/globalSetup.ts'],
      setupFiles: ['./apps/api/tests/setup-db.ts'],
    },
  },
  // scripts 测试
  {
    test: {
      include: ['scripts/__tests__/**/*.test.ts'],
      exclude: baseExclude,
      environment: 'node',
    },
  },
]);
