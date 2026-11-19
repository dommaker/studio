/**
 * projects 域契约测试：实体/请求/响应 schema 的接受-拒绝边界。
 * schema 即正本（原 LocalProject 手写 interface 双写互验 parity 层已退役，类型同源由编译期断言锚定）。
 */

import { describe, it, expect } from 'vitest';
import {
  localProjectSchema,
  type LocalProject,
  projectExcludeSchema,
  discoverProjectsQuerySchema,
  putProjectExcludeBodySchema,
  localProjectListResponseSchema,
  projectExcludeResponseSchema,
} from '../projects.js';
import * as contractIndex from '../index.js';

/** 后端 LocalProject 全字段最小合法形状 */
const projectRow: LocalProject = {
  name: 'studio',
  path: '/root/projects/studio',
  hasClaudeMd: true,
};

describe('localProjectSchema', () => {
  it('必填字段删除即拒；language 可选', () => {
    expect(localProjectSchema.parse({ ...projectRow, language: 'typescript' }))
      .toEqual({ ...projectRow, language: 'typescript' });
    expect(localProjectSchema.parse(projectRow)).toEqual(projectRow);
    for (const key of Object.keys(projectRow)) {
      const { [key]: _drop, ...rest } = projectRow as unknown as Record<string, unknown>;
      expect(localProjectSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('请求 schema', () => {
  it('discover query：search 可选透传', () => {
    expect(discoverProjectsQuerySchema.parse({})).toEqual({});
    expect(discoverProjectsQuerySchema.parse({ search: 'stu' })).toEqual({ search: 'stu' });
  });

  it('PUT /exclude body：exclude 须字符串数组（旧手写 guard 同口径 400）', () => {
    expect(putProjectExcludeBodySchema.parse({ exclude: ['a', '/data/secret'] })).toBeTruthy();
    expect(putProjectExcludeBodySchema.parse({ exclude: [] }).exclude).toEqual([]);
    expect(putProjectExcludeBodySchema.safeParse({ exclude: 'a' }).success).toBe(false);
    expect(putProjectExcludeBodySchema.safeParse({ exclude: [1, 2] }).success).toBe(false);
    expect(putProjectExcludeBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('响应壳', () => {
  it('{ data } 统一壳（原 {success,data} 平铺壳退役）', () => {
    expect(localProjectListResponseSchema.parse({ data: [projectRow] }).data).toHaveLength(1);
    expect(projectExcludeSchema.parse({ exclude: ['x'] })).toBeTruthy();
    expect(projectExcludeResponseSchema.parse({ data: { exclude: [] } }).data.exclude).toEqual([]);
  });

  it('index.ts 出口包含 projects 域 schema', () => {
    expect(contractIndex.localProjectSchema).toBe(localProjectSchema);
    expect(contractIndex.putProjectExcludeBodySchema).toBe(putProjectExcludeBodySchema);
  });
});
