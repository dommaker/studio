import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup-db.ts'],
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@dommaker/studio-prisma': path.resolve(__dirname, '../../packages/studio-prisma/src'),
      '@dommaker/studio-shared': path.resolve(__dirname, '../../packages/studio-shared/src'),
    },
  },
});
