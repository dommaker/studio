import * as path from 'node:path';
import type { Company } from '@dommaker/studio-contract';
import { generateId } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../core/store.js';

const COMPANIES_DIR = studioPath('data', 'companies');

export function companyPath(id: string): string {
  return path.join(COMPANIES_DIR, `${id}.json`);
}

export interface CompanyStorePort {
  list(): Promise<Company[]>;
  save(company: Company): Promise<void>;
}

export interface CompanyApplicationDeps {
  store: CompanyStorePort;
  createDefaultOKR(companyId: string): Promise<unknown>;
  warn(context: { companyId: string; okrError: unknown }, message: string): void | Promise<void>;
  generateId(prefix: string): string;
  now(): Date;
}

function createCompanyStore(): CompanyStorePort {
  const store = getStore();
  return {
    list: () => store.listJsonInDir<Company>(COMPANIES_DIR),
    save: company => store.writeJson(companyPath(company.id), company),
  };
}

function productionDeps(): CompanyApplicationDeps {
  return {
    store: createCompanyStore(),
    createDefaultOKR: async companyId => {
      const { getOkrService } = await import('../pmo/index.js');
      return getOkrService().createDefaultOKR(companyId);
    },
    warn: async (context, message) => {
      const { logger } = await import('../../utils/logger.js');
      logger.warn(context, message);
    },
    generateId,
    now: () => new Date(),
  };
}

/** 创建公司；默认 OKR 是 best-effort 附属效果，失败不回滚公司已创建结果。 */
export async function createCompany(name: string, deps: CompanyApplicationDeps = productionDeps()): Promise<Company> {
  const id = deps.generateId('company');
  const now = deps.now().toISOString();
  const company: Company = { id, name, size: 'custom', createdAt: now, updatedAt: now };
  await deps.store.save(company);

  try {
    await deps.createDefaultOKR(company.id);
  } catch (okrError) {
    await deps.warn({ companyId: company.id, okrError }, 'Failed to create default OKR');
  }
  return company;
}

/** 公司列表；空库时由服务端创建默认公司，响应按创建时间倒序。 */
export async function listCompanies(deps: CompanyApplicationDeps = productionDeps()): Promise<Company[]> {
  let companies = await deps.store.list();
  if (companies.length === 0) {
    companies = [await createCompany('我的工作空间', deps)];
  }
  return companies.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
