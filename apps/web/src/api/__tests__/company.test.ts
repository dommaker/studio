// companyApi — 公司 CRUD：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPatch: vi.fn(),
}));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost, patch: mockPatch } }));

import { companyApi } from '../company';

describe('companyApi（公司 CRUD）', () => {
  it('list → GET /companies（默认公司取 data[0]）', () => {
    companyApi.list();
    expect(mockGet).toHaveBeenCalledWith('/companies');
  });

  it('get → GET /companies/:id', () => {
    companyApi.get('co-1');
    expect(mockGet).toHaveBeenCalledWith('/companies/co-1');
  });

  it('create → POST /companies（服务端自动建默认 OKR）', () => {
    companyApi.create({ name: '我的工作空间' });
    expect(mockPost).toHaveBeenCalledWith('/companies', { name: '我的工作空间' });
  });

  it('update → PATCH /companies/:id（Settings 页公司名自动保存）', () => {
    companyApi.update('co-1', { name: '新名字' });
    expect(mockPatch).toHaveBeenCalledWith('/companies/co-1', { name: '新名字' });
  });
});
