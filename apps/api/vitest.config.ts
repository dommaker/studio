import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup-isolated-data.setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    // SQLite 不支持并发写入, 串行执行测试文件
    maxConcurrency: 1,
    // 测试环境跳过认证（.env 中 STUDIO_AUTH=on / NODE_ENV=production 是 production 配置）
    env: { STUDIO_AUTH: 'none', NODE_ENV: 'test' },
  },
  resolve: {
    alias: {
      // studio-dir 子路径在 src/config/ 下，扁平别名覆盖不到，需精确条目（须置于通用条目前）
      '@dommaker/studio-shared/studio-dir': path.resolve(__dirname, '../../packages/studio-shared/src/config/studio-dir.ts'),
      '@dommaker/studio-shared': path.resolve(__dirname, '../../packages/studio-shared/src'),
    },
  },
});
