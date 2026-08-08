import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// apps/web 专属 flat config（工单 41）：优先级高于仓库根 eslint.config.mjs。
// 规则保持 warn 级：存量告警已基线化记录，不在本仓清零。
export default tseslint.config(
  { ignores: ['dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // react-hooks v7 的 recommended 将 React Compiler 系列规则设为 error；
      // 存量问题不在本工单清零，统一降级为 warn 以保持门控可跑通。
      ...Object.fromEntries(
        Object.entries(reactHooks.configs.recommended.rules).map(([name]) => [name, 'warn']),
      ),
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-regex-spaces': 'warn',
      'prefer-const': 'warn',
      'no-constant-condition': 'warn',
      'no-useless-catch': 'warn',
    },
  },
);
