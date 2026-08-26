import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/mkdtemp-cleanup-setup.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});