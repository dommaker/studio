// pmoApi — PMO 项目（projectApi，P3-a 自 api/index.ts 归位）+ OKR（okrApi）：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost, mockPut, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
}));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost, put: mockPut, delete: mockDelete } }));

import { okrApi, projectApi } from '../pmo';

describe('projectApi（PMO 项目管理，GEN-005）', () => {
  it('create → POST /pmo/project（companyId 由服务端解析，前端不传）', () => {
    const payload = { title: '新项目', gitRepo: '/repo/a', gitRepos: ['/repo/a', '/repo/b'] };
    projectApi.create(payload);
    expect(mockPost).toHaveBeenCalledWith('/pmo/project', payload);
  });

  it('list → GET /pmo/project?companyId=', () => {
    projectApi.list({ companyId: 'co-1', status: 'active' });
    expect(mockGet).toHaveBeenCalledWith('/pmo/project', { params: { companyId: 'co-1', status: 'active' } });
  });

  it('get / getByPmoNumber → 详情两入口', () => {
    projectApi.get('p-1');
    expect(mockGet).toHaveBeenCalledWith('/pmo/project/p-1');
    projectApi.getByPmoNumber('PMO-001', 'co-1');
    expect(mockGet).toHaveBeenCalledWith('/pmo/project/by-pmo/PMO-001', { params: { companyId: 'co-1' } });
  });

  it('update / updateStatus → PUT', () => {
    projectApi.update('p-1', { title: '改名' });
    expect(mockPut).toHaveBeenCalledWith('/pmo/project/p-1', { title: '改名' });
    projectApi.updateStatus('p-1', 'active');
    expect(mockPut).toHaveBeenCalledWith('/pmo/project/p-1/status', { status: 'active' });
  });

  it('publish → POST /pmo/project/:id/publish（assigneeId 缺省不带）', () => {
    projectApi.publish('p-1', 'ch-1');
    expect(mockPost).toHaveBeenCalledWith('/pmo/project/p-1/publish', { channelId: 'ch-1' });
    projectApi.publish('p-1', 'ch-1', 'role-1');
    expect(mockPost).toHaveBeenCalledWith('/pmo/project/p-1/publish', { channelId: 'ch-1', assigneeId: 'role-1' });
  });

  it('delete → DELETE /pmo/project/:id', () => {
    projectApi.delete('p-1');
    expect(mockDelete).toHaveBeenCalledWith('/pmo/project/p-1');
  });

  it('parseCommand → POST /pmo/project/parse-command', () => {
    projectApi.parseCommand('@PMO-001 继续');
    expect(mockPost).toHaveBeenCalledWith('/pmo/project/parse-command', { command: '@PMO-001 继续' });
  });

  it('交付台账三端点：getDelivery / deliver / markDelivered', () => {
    projectApi.getDelivery('p-1');
    expect(mockGet).toHaveBeenCalledWith('/pmo/project/p-1/delivery');
    projectApi.deliver('p-1');
    expect(mockPost).toHaveBeenCalledWith('/pmo/project/p-1/deliver');
    projectApi.markDelivered('p-1', 'abc123');
    expect(mockPost).toHaveBeenCalledWith('/pmo/project/p-1/mark-delivered', { commit: 'abc123' });
  });
});

describe('okrApi（PMO OKR）', () => {
  it('list → GET /pmo/okr?companyId=（companyId 必填）', () => {
    okrApi.list('co-1');
    expect(mockGet).toHaveBeenCalledWith('/pmo/okr', { params: { companyId: 'co-1' } });
  });

  it('list 带 status 过滤', () => {
    okrApi.list('co-1', 'active');
    expect(mockGet).toHaveBeenCalledWith('/pmo/okr', { params: { companyId: 'co-1', status: 'active' } });
  });

  it('create → POST /pmo/okr（PMOPage 新建 OKR）', () => {
    const payload = {
      companyId: 'co-1',
      title: 'Q3 增长',
      quarter: '2026-Q3',
      objectives: [{ id: 'o1', title: 'Q3 增长' }],
      keyResults: [{ id: 'kr1', objectiveId: 'o1', title: 'KR1', target: 100, current: 0, unit: '%' }],
    };
    okrApi.create(payload);
    expect(mockPost).toHaveBeenCalledWith('/pmo/okr', payload);
  });
});
