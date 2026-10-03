/**
 * builtin-tools 域契约测试：请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/builtin-tools/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  builtinToolSchema,
  builtinToolListQuerySchema,
  builtinToolPatchBodySchema,
  builtinToolListResponseSchema,
  builtinToolGetResponseSchema,
} from '../builtin-tools.js';
import * as contractIndex from '../index.js';

const TOOL = {
  name: 'read_file',
  description: '读取文件内容',
  category: 'file' as const,
  inputSchema: { type: 'object', required: ['path'] },
  enabled: true,
};

describe('builtinToolSchema', () => {
  it('category 四词表', () => {
    expect(builtinToolSchema.parse(TOOL).name).toBe('read_file');
    expect(() => builtinToolSchema.parse({ ...TOOL, category: 'network' })).toThrow();
  });
});

describe('请求边界', () => {
  it('GET /：category 自由串（词表外值 → 空列表，原语义）', () => {
    expect(builtinToolListQuerySchema.parse({ category: 'whatever' }).category).toBe('whatever');
    expect(builtinToolListQuerySchema.parse({}).category).toBeUndefined();
  });

  it('PATCH /:name：非 boolean enabled 收紧 400（原静默忽略）', () => {
    expect(builtinToolPatchBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(builtinToolPatchBodySchema.parse({})).toEqual({});
    expect(() => builtinToolPatchBodySchema.parse({ enabled: 'true' })).toThrow();
  });
});

describe('响应壳', () => {
  it('GET / → { data: { tools, total, categories } }（名词键，避免 data.data 双包）', () => {
    const body = { data: { tools: [TOOL], total: 1, categories: ['file'] } };
    expect(builtinToolListResponseSchema.parse(body).data.tools[0].name).toBe('read_file');
  });

  it('GET /:name → { data: tool }（裸实体进壳）', () => {
    expect(builtinToolGetResponseSchema.parse({ data: TOOL }).data.enabled).toBe(true);
  });
});

describe('index.ts 出口', () => {
  it('builtin-tools 域 schema 经 index 导出', () => {
    expect(contractIndex.builtinToolSchema).toBeDefined();
    expect(contractIndex.builtinToolListResponseSchema).toBeDefined();
  });
});
