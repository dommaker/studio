/**
 * no-hand-copied-api-types — web api 层手抄类型防回潮规则单元测试（P3-a）
 * RuleTester 规则行为：禁 export interface / 非契约别名 export type，
 * 放行 re-export 与契约别名形态。
 */
import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from '../eslint-rules/no-hand-copied-api-types.mjs';

const F = 'apps/web/src/api/example.ts';

describe('rule（RuleTester）', () => {
  const tester = new RuleTester({
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
  });
  tester.run('no-hand-copied-api-types', rule, {
    valid: [
      // re-export（带 source / 不带 source）
      { code: `export type { Project } from '@dommaker/studio-contract';`, filename: F },
      { code: `import type { Project } from '@dommaker/studio-contract'; export type { Project };`, filename: F },
      { code: `export type { ChannelMessage } from '../types/channel';`, filename: F },
      // 契约别名（裸标识符引用，含泛型）
      { code: `import type { Resolution } from '@dommaker/studio-contract'; export type ResolutionItem = Resolution;`, filename: F },
      { code: `import type { PaginatedBody } from '@dommaker/studio-contract'; export type PaginatedResponse<T> = PaginatedBody<T>;`, filename: F },
      // 非导出声明不拦（文件内部局部类型）
      { code: `interface Internal { a: string } type Local = { b: number }; export const x = 1;`, filename: F },
      // 值导出不拦
      { code: `export const someApi = { list: () => 1 };`, filename: F },
      { code: `export function foo() { return 1; }`, filename: F },
    ],
    invalid: [
      // 手抄 interface
      {
        code: `export interface Project { id: string; title: string }`,
        filename: F,
        errors: [{ messageId: 'noInterface' }],
      },
      // 继承契约的 interface 也不放行（本地扩展 → src/types/）
      {
        code: `import type { ChannelMessage as C } from '@dommaker/studio-contract'; export interface ChannelMessage extends C { pending?: boolean }`,
        filename: F,
        errors: [{ messageId: 'noInterface' }],
      },
      // 对象字面别名
      {
        code: `export type Query = { companyId: string; limit?: number }`,
        filename: F,
        errors: [{ messageId: 'noTypeAlias' }],
      },
      // 字面量联合
      {
        code: `export type Status = 'active' | 'done'`,
        filename: F,
        errors: [{ messageId: 'noTypeAlias' }],
      },
      // 交叉类型（含契约引用也不行 → src/types/）
      {
        code: `import type { R } from '@dommaker/studio-contract'; export type Resp = R & { extra?: string }`,
        filename: F,
        errors: [{ messageId: 'noTypeAlias' }],
      },
      // 索引访问（= Contract['key'] → 直接别名契约导出的值域类型）
      {
        code: `import type { R } from '@dommaker/studio-contract'; export type S = R['status']`,
        filename: F,
        errors: [{ messageId: 'noTypeAlias' }],
      },
      // 数组/限定名引用
      {
        code: `import type { R } from '@dommaker/studio-contract'; export type L = R[]`,
        filename: F,
        errors: [{ messageId: 'noTypeAlias' }],
      },
    ],
  });
  it('RuleTester 断言通过', () => {
    expect(true).toBe(true); // RuleTester 失败会直接抛错
  });
});
