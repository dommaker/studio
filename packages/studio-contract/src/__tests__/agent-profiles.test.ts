/**
 * agent-profiles / agent-instances 域契约测试：实体 parity（手写 interface ↔ schema 互验）
 * + 请求 schema（name/roleId 必填收 zod）+ 响应壳。
 * 正本 = apps/api/src/modules/agents/agent-profile.service.ts（AgentProfileData wire）
 * + agent-instance.service.ts（RuntimeStateData wire）。
 */

import { describe, it, expect } from 'vitest';
import {
  agentProfileSchema,
  type AgentProfile,
  agentProfileListItemSchema,
  type AgentProfileListItem,
  rolePresetSummarySchema,
  type RolePresetSummary,
  agentInstanceSchema,
  type AgentInstance,
  agentProfileListQuerySchema,
  createAgentProfileBodySchema,
  updateAgentProfileBodySchema,
  agentProfileIdParamsSchema,
  agentInstanceListQuerySchema,
  createAgentInstanceBodySchema,
  updateAgentInstanceBodySchema,
  agentInstanceIdParamsSchema,
  agentProfileListResponseSchema,
  agentProfileResponseSchema,
  rolePresetListResponseSchema,
  agentInstanceListResponseSchema,
  agentInstanceResponseSchema,
} from '../agent-profiles.js';
import * as contractIndex from '../index.js';

const profile: AgentProfile = {
  id: 'p-1',
  name: 'dev-agent',
  description: '开发角色',
  channels: '["ch-1"]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
  acceptedTypes: ['DEV'],
  persona: '你是开发角色',
  skills: ['commit'],
  tools: ['fs.read'],
  constraints: { noForcePush: true },
  kind: 'user',
};

const listItem: AgentProfileListItem = {
  ...profile,
  isOnline: true,
  lastError: null,
  lastErrorAt: null,
};

const instance: AgentInstance = {
  id: 'inst-1',
  roleId: 'p-1',
  sessionId: 'sess-1',
  status: 'active',
  currentWorkUnitId: 'wu-1',
  startedAt: '2026-09-01T00:00:00.000Z',
  terminatedAt: null,
  lastHeartbeat: '2026-09-01T01:00:00.000Z',
  metadata: null,
  pid: 1234,
  lastError: null,
  lastErrorAt: null,
  updatedAt: '2026-09-01T01:00:00.000Z',
};

const preset: RolePresetSummary = { name: 'qa', description: '测试角色' };

describe('agentProfileSchema / agentProfileListItemSchema', () => {
  it('parity：AgentProfile fixture（全字段）通过校验；可省字段缺省合法', () => {
    expect(agentProfileSchema.parse(profile)).toEqual(profile);
    const minimal: AgentProfile = {
      id: 'p-2',
      name: 'bare',
      description: null,
      channels: '[]',
      status: 'inactive',
      provider: null,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    expect(agentProfileSchema.parse(minimal)).toEqual(minimal);
    expect(() => agentProfileSchema.parse({ ...profile, id: undefined })).toThrow();
    expect(() => agentProfileSchema.parse({ ...profile, name: undefined })).toThrow();
    expect(() => agentProfileSchema.parse({ ...profile, createdAt: undefined })).toThrow();
  });

  it('parity：kind 词表（system/user）；历史无 kind 记录合法', () => {
    const { kind: _kind, ...noKind } = profile;
    expect(agentProfileSchema.parse(noKind)).toEqual(noKind);
    expect(() => agentProfileSchema.parse({ ...profile, kind: 'robot' })).toThrow();
  });

  it('parity：AgentProfileListItem = AgentProfile + 实例态聚合三键', () => {
    expect(agentProfileListItemSchema.parse(listItem)).toEqual(listItem);
    expect(() => agentProfileListItemSchema.parse(profile)).toThrow();
  });
});

describe('rolePresetSummarySchema', () => {
  it('parity：name 必填、description 可选（死字段不浮出）', () => {
    expect(rolePresetSummarySchema.parse(preset)).toEqual(preset);
    expect(rolePresetSummarySchema.parse({ name: 'bare' })).toEqual({ name: 'bare' });
    expect(() => rolePresetSummarySchema.parse({ description: 'x' })).toThrow();
  });
});

describe('agentInstanceSchema', () => {
  it('parity：AgentInstance fixture（全字段）通过校验；可省字段缺省合法', () => {
    expect(agentInstanceSchema.parse(instance)).toEqual(instance);
    const minimal: AgentInstance = {
      id: 'inst-2',
      roleId: 'p-1',
      sessionId: null,
      status: 'idle',
      currentWorkUnitId: null,
      startedAt: instance.startedAt,
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: null,
    };
    expect(agentInstanceSchema.parse(minimal)).toEqual(minimal);
    expect(() => agentInstanceSchema.parse({ ...instance, roleId: undefined })).toThrow();
    expect(() => agentInstanceSchema.parse({ ...instance, startedAt: undefined })).toThrow();
  });
});

describe('请求 schema', () => {
  it('list query：过滤键与分页串全可选', () => {
    expect(agentProfileListQuerySchema.parse({})).toEqual({});
    expect(agentProfileListQuerySchema.parse({ status: 'active', includeSystem: 'true', limit: '200' }))
      .toEqual({ status: 'active', includeSystem: 'true', limit: '200' });
    expect(agentInstanceListQuerySchema.parse({ status: 'idle' })).toEqual({ status: 'idle' });
  });

  it('create body：name/roleId 必填（原手写 400 收 zod），其余可选', () => {
    expect(createAgentProfileBodySchema.parse({ name: 'a' })).toEqual({ name: 'a' });
    expect(() => createAgentProfileBodySchema.parse({})).toThrow();
    expect(() => createAgentProfileBodySchema.parse({ name: '' })).toThrow();
    expect(createAgentProfileBodySchema.parse({
      name: 'a', preset: 'qa', channels: ['ch-1'], skills: [], acceptedTypes: ['DEV'],
    })).toEqual({ name: 'a', preset: 'qa', channels: ['ch-1'], skills: [], acceptedTypes: ['DEV'] });

    expect(createAgentInstanceBodySchema.parse({ roleId: 'p-1' })).toEqual({ roleId: 'p-1' });
    expect(() => createAgentInstanceBodySchema.parse({})).toThrow();
  });

  it('update body：全可选；null 清空键合法', () => {
    expect(updateAgentProfileBodySchema.parse({})).toEqual({});
    expect(updateAgentProfileBodySchema.parse({ description: null, provider: null, persona: null }))
      .toEqual({ description: null, provider: null, persona: null });
    expect(updateAgentInstanceBodySchema.parse({ status: 'idle', currentWorkUnitId: null }))
      .toEqual({ status: 'idle', currentWorkUnitId: null });
  });

  it('params：id 必填非空', () => {
    expect(agentProfileIdParamsSchema.parse({ id: 'p-1' })).toEqual({ id: 'p-1' });
    expect(agentInstanceIdParamsSchema.parse({ id: 'i-1' })).toEqual({ id: 'i-1' });
    expect(() => agentProfileIdParamsSchema.parse({ id: '' })).toThrow();
  });
});

describe('响应壳', () => {
  it('列表分页壳 / 单实体壳 / presets 壳', () => {
    const page = { data: [listItem], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
    expect(agentProfileListResponseSchema.parse(page)).toEqual(page);
    expect(agentProfileResponseSchema.parse({ data: profile }).data.name).toBe('dev-agent');
    expect(rolePresetListResponseSchema.parse({ data: [preset] }).data[0].name).toBe('qa');

    const instPage = { data: [instance], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
    expect(agentInstanceListResponseSchema.parse(instPage)).toEqual(instPage);
    expect(agentInstanceResponseSchema.parse({ data: instance }).data.roleId).toBe('p-1');
  });
});

describe('index.ts 出口', () => {
  it('agent-profiles 域 schema 经 index 导出', () => {
    expect(contractIndex.agentProfileSchema).toBeDefined();
    expect(contractIndex.agentProfileListResponseSchema).toBeDefined();
    expect(contractIndex.agentInstanceSchema).toBeDefined();
    expect(contractIndex.agentInstanceResponseSchema).toBeDefined();
  });
});
