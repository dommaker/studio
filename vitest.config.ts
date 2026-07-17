import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: __dirname,
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    exclude: ['tests/frontend/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'packages/*/src/**/*.d.ts'],
    },
    envFile: './.env.test',
    env: {
      DATABASE_URL: 'file:./test.db',
    },
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
    deps: {
      interopDefault: true,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@dommaker/studio-prisma': path.resolve(__dirname, './packages/studio-prisma/src'),
      '@dommaker/studio-shared': path.resolve(__dirname, './packages/studio-shared/src'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    tsconfigRaw: {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'node',
      },
    },
  },
});