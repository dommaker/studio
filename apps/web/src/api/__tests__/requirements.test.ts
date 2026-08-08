// Contract test: Requirement API client — REQ 需求编号体系（vision §5.3）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { requirementApi, requirementsDocApi } from '../requirements';
import { api } from '../index';

describe('requirementApi', () => {
  it('list passes filters as params', async () => {
    await requirementApi.list({ status: 'in-progress', channelId: 'ch-1' });
    expect(api.get).toHaveBeenCalledWith('/requirements', { params: { status: 'in-progress', channelId: 'ch-1' } });
  });

  it('list works without filters', async () => {
    await requirementApi.list();
    expect(api.get).toHaveBeenCalledWith('/requirements', { params: undefined });
  });

  it('get calls correct endpoint', async () => {
    await requirementApi.get('REQ-0042');
    expect(api.get).toHaveBeenCalledWith('/requirements/REQ-0042');
  });

  it('create posts payload', async () => {
    await requirementApi.create({ title: '新需求', channelId: 'ch-1' });
    expect(api.post).toHaveBeenCalledWith('/requirements', { title: '新需求', channelId: 'ch-1' });
  });

  it('update patches payload', async () => {
    await requirementApi.update('REQ-0042', { status: 'done', docs: ['a.md'] });
    expect(api.patch).toHaveBeenCalledWith('/requirements/REQ-0042', { status: 'done', docs: ['a.md'] });
  });

  it('getChain calls correct endpoint', async () => {
    await requirementApi.getChain('REQ-0042');
    expect(api.get).toHaveBeenCalledWith('/requirements/REQ-0042/chain');
  });
});

describe('requirementsDocApi（B2-009 SDD 需求文档编辑）', () => {
  it('update → PUT /requirements-docs/:id（RequirementsDocCard 编辑保存）', async () => {
    await requirementsDocApi.update('doc-1', '# 新内容');
    expect(api.put).toHaveBeenCalledWith('/requirements-docs/doc-1', { content: '# 新内容' });
  });
});
