/**
 * E2E-only vitest workspace — 一期验收总标准（tests/e2e 下的 *.e2e.test.ts）。
 *
 * 默认矩阵 vitest.workspace.ts 显式排除 `*.e2e.test.ts`（它们需要拉起真实
 * API 子进程，不适合随 `pnpm test` 跑）。vitest 1.x 下 --config 不会覆盖
 * workspace 文件，因此 e2e 用独立的 workspace 文件接入：
 *   pnpm test:e2e   →   vitest run --workspace vitest.e2e.workspace.ts
 */

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      globals: true,
      environment: 'node' as const,
      pool: 'forks' as const,
      include: ['tests/e2e/**/*.e2e.test.ts'],
      // 套件内 it 之间有状态依赖（频道/profile/WorkUnit 依次创建），单文件串行
      fileParallelism: false,
      testTimeout: 300_000,
      hookTimeout: 180_000,
    },
  },
]);
