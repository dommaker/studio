import { defineWorkspace } from 'vitest/config';

const baseExclude = ['**/node_modules/**'];

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
  // apps 测试（排除 daemon — 需 Claude CLI + git worktree）
  {
    test: {
      include: ['apps/**/src/**/*.test.ts'],
      exclude: ['apps/api/src/daemon/**', ...baseExclude],
      environment: 'node',
      globalSetup: ['./tests/globalSetup.ts'],
    },
  },
  // apps tests/ 目录
  {
    test: {
      include: ['apps/**/tests/**/*.test.ts'],
      exclude: baseExclude,
      environment: 'node',
      globalSetup: ['./tests/globalSetup.ts'],
    },
  },
]);
