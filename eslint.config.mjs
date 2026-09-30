import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 由旧 .eslintrc.cjs 迁移的 flat config（工单 41）
// packages/* 子包运行 `eslint src/**/*.ts` 时向上查找并复用本配置。
// 规则全部保持 warn 级：lint 门控只要求跑通，存量告警已基线化记录，不在本仓清零。
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/coverage-*/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-regex-spaces': 'warn',
      'prefer-const': 'warn',
      'no-constant-condition': 'warn',
      'no-useless-catch': 'warn',
      // P2-b FileStore 存储边界收口（docs/architecture/target-architecture.md）：
      // 无参 new FileStore() 全仓封禁——生产代码一律 core/store.ts getStore()（apps/api）
      // 或 studio-shared getDefaultFileStore()（packages）；显式 root 构造（测试/脚本/bench）合法。
      'no-restricted-syntax': ['error', {
        selector: "NewExpression[callee.name='FileStore'][arguments.length=0]",
        message: '禁止无参 new FileStore()：apps/api 用 core/store.ts 的 getStore()，packages 用 getDefaultFileStore()；显式 root 构造不受限。',
      }],
    },
  },
  {
    // 测试豁免：隔离测试允许直接构造（含无参，env 由 setup 钉隔离根）
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.spec.ts', '**/tests/**'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
);
