import { describe, expect, it, vi } from 'vitest';
import type { Company } from '@dommaker/studio-contract';
import { createCompany, listCompanies, type CompanyApplicationDeps } from '../company-application.js';

function deps(overrides: Partial<CompanyApplicationDeps> = {}): CompanyApplicationDeps {
  return {
    store: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
    },
    createDefaultOKR: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    generateId: vi.fn(() => 'company_test'),
    now: vi.fn(() => new Date('2026-01-02T00:00:00.000Z')),
    ...overrides,
  };
}

describe('Company application use cases（ARCH-06）', () => {
  it('创建公司后创建默认 OKR；OKR 失败只告警且仍返回公司已创建结果', async () => {
    const okrError = new Error('OKR unavailable');
    const injected = deps({ createDefaultOKR: vi.fn().mockRejectedValue(okrError) });

    const company = await createCompany('测试公司', injected);

    expect(company).toEqual({
      id: 'company_test',
      name: '测试公司',
      size: 'custom',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(injected.store.save).toHaveBeenCalledWith(company);
    expect(injected.createDefaultOKR).toHaveBeenCalledWith('company_test');
    expect(injected.warn).toHaveBeenCalledWith({ companyId: 'company_test', okrError }, 'Failed to create default OKR');
  });

  it('空库列表创建默认公司，非空列表只按创建时间倒序返回', async () => {
    const empty = deps();
    await expect(listCompanies(empty)).resolves.toEqual([
      expect.objectContaining({ id: 'company_test', name: '我的工作空间' }),
    ]);
    expect(empty.store.list).toHaveBeenCalledWith();

    const companies: Company[] = [
      { id: 'old', name: 'Old', size: 'custom', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', name: 'New', size: 'custom', createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
    ];
    const nonEmpty = deps({ store: { list: vi.fn().mockResolvedValue(companies), save: vi.fn() } });
    await expect(listCompanies(nonEmpty)).resolves.toEqual([companies[1], companies[0]]);
    expect(nonEmpty.createDefaultOKR).not.toHaveBeenCalled();
  });
});
