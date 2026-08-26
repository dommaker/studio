import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../studio-shared/tests/mkdtemp-cleanup-setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
