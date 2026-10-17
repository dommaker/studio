/**
 * workspaces 域契约测试：实体/请求/响应 schema 的接受-拒绝边界。
 * schema 即正本（原 Workspace 手写 interface 双写互验 parity 层已退役，类型同源由编译期断言锚定）。
 */

import { describe, it, expect } from 'vitest';
import {
  workspaceSchema,
  type Workspace,
  workspaceRuntimeSchema,
  workspaceRuntimesResultSchema,
  workspaceIdParamsSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  workspaceRuntimesResponseSchema,
} from '../workspaces.js';
import * as contractIndex from '../index.js';

/** 后端本机记录已知字段最小合法形状（local-workspace.ts 写入；runtimes 可选） */
const workspaceRow: Workspace = {
  id: 'ws_1',
  name: 'VPS',
  workspaceRoot: '/root/projects',
  status: 'idle',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('workspaceSchema', () => {
  it('接受记录形状（含历史扩展字段 passthrough 与 runtimes）', () => {
    expect(workspaceSchema.parse(workspaceRow)).toEqual(workspaceRow);
    const withExtras = workspaceSchema.parse({
      ...workspaceRow,
      hasDocker: false,
      os: 'linux',
      arch: 'x64',
      tokenId: null,
      runtimes: [{ id: 'ws_1_claude', provider: 'claude', name: 'claude', version: '2.1.0', path: '/usr/bin/claude', status: 'online' }],
    });
    expect(withExtras.runtimes).toHaveLength(1);
    expect((withExtras as Record<string, unknown>).hasDocker).toBe(false);
  });

  it('必填字段删除即拒', () => {
    for (const key of Object.keys(workspaceRow)) {
      const { [key]: _drop, ...rest } = workspaceRow as Record<string, unknown>;
      expect(workspaceSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('workspaceRuntimeSchema', () => {
  it('provider 必填，其余可缺省；modelsSource 词表；未知键 passthrough', () => {
    expect(workspaceRuntimeSchema.parse({ provider: 'claude' })).toEqual({ provider: 'claude' });
    expect(workspaceRuntimeSchema.safeParse({}).success).toBe(false);
    expect(workspaceRuntimeSchema.parse({ provider: 'claude', version: null, authHint: 'h' })).toBeTruthy();
    expect(workspaceRuntimeSchema.safeParse({ provider: 'claude', modelsSource: 'bogus' }).success).toBe(false);
    expect(workspaceRuntimeSchema.parse({ provider: 'claude', authProbe: { at: 't' } })).toBeTruthy();
  });
});

describe('请求与响应', () => {
  it('params 边界', () => {
    expect(workspaceIdParamsSchema.parse({ id: 'ws_1' })).toEqual({ id: 'ws_1' });
    expect(workspaceIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('{ data } 统一壳', () => {
    expect(workspaceListResponseSchema.parse({ data: [workspaceRow] }).data).toHaveLength(1);
    expect(workspaceResponseSchema.parse({ data: workspaceRow }).data.id).toBe('ws_1');
    expect(workspaceRuntimesResultSchema.parse({ runtimes: [] })).toEqual({ runtimes: [] });
    expect(workspaceRuntimesResponseSchema.parse({ data: { runtimes: [{ provider: 'kimi' }] } })).toBeTruthy();
  });

  it('index.ts 出口包含 workspaces 域 schema', () => {
    expect(contractIndex.workspaceSchema).toBe(workspaceSchema);
    expect(contractIndex.workspaceRuntimeSchema).toBe(workspaceRuntimeSchema);
  });
});
