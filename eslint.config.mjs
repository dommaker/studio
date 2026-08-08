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
    },
  },
);
