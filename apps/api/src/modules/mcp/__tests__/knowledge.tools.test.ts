/**
 * knowledge.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 queryKnowledge / extractKnowledge / storeKnowledge / searchKnowledge / getMaturity。
 * HOME 指向临时目录以隔离真实文档数据（模块在设置 HOME 之后动态导入）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let knowledgeTools: import('../tool-registry.js').RegisteredTool[];
let DOCUMENTS_DIR: string;

function tool(name: string) {
  const t = knowledgeTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

function writeDoc(id: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCUMENTS_DIR, `${id}.json`), JSON.stringify({
    id, projectId: 'p1', companyId: 'c1', title: id, content: `content of ${id}`,
    type: 'design', tags: [], status: 'active', createdAt: now, updatedAt: now, ...patch,
  }));
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-knowledge-tools-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const mod = await import('../knowledge.tools.js');
  knowledgeTools = mod.knowledgeTools;
  DOCUMENTS_DIR = (await import('../tool-store.js')).getDocumentsDir();
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('knowledge.tools', () => {
  it('导出 5 个 tool，注册顺序不变', () => {
    expect(knowledgeTools.map(t => t.name)).toEqual([
      'queryKnowledge', 'extractKnowledge', 'storeKnowledge', 'searchKnowledge', 'getMaturity',
    ]);
  });

  it('extractKnowledge 存储文档并返回 { documentId, title }', async () => {
    const result = await tool('extractKnowledge').handler({
      projectId: 'p1', companyId: 'c1', title: 'Doc A', content: 'hello', type: 'requirement',
    });
    expect(result.title).toBe('Doc A');
    expect(result.documentId).toMatch(/^doc_/);
    const saved = JSON.parse(fs.readFileSync(path.join(DOCUMENTS_DIR, `${result.documentId}.json`), 'utf-8'));
    expect(saved).toMatchObject({
      projectId: 'p1', companyId: 'c1', title: 'Doc A', content: 'hello',
      type: 'requirement', tags: [], status: 'active',
    });
    expect(tool('extractKnowledge').inputSchema.required)
      .toEqual(['projectId', 'companyId', 'title', 'content', 'type']);
  });

  it('storeKnowledge 保存 filePath 并返回 type', async () => {
    const result = await tool('storeKnowledge').handler({
      projectId: 'p1', companyId: 'c1', title: 'Doc B', content: 'c', type: 'archive', filePath: '/tmp/x.md',
    });
    expect(result.type).toBe('archive');
    const saved = JSON.parse(fs.readFileSync(path.join(DOCUMENTS_DIR, `${result.documentId}.json`), 'utf-8'));
    expect(saved.filePath).toBe('/tmp/x.md');
  });

  it('queryKnowledge 过滤 companyId+active，支持 search/type/limit', async () => {
    writeDoc('q_a', { companyId: 'cq', title: 'Alpha spec', updatedAt: '2026-01-02T00:00:00.000Z' });
    writeDoc('q_b', { companyId: 'cq', content: 'mentions alpha', type: 'spec', updatedAt: '2026-01-03T00:00:00.000Z' });
    writeDoc('q_c', { companyId: 'cq', title: 'alpha archived', status: 'archived' });
    writeDoc('q_d', { companyId: 'other', title: 'alpha other' });

    const all = await tool('queryKnowledge').handler({ companyId: 'cq', search: 'alpha' });
    expect(all.total).toBe(2);
    expect(all.documents.map((d: any) => d.id)).toEqual(['q_b', 'q_a']);
    expect(all.documents[0]).not.toHaveProperty('projectId');

    const typed = await tool('queryKnowledge').handler({ companyId: 'cq', search: 'alpha', type: 'spec' });
    expect(typed.documents.map((d: any) => d.id)).toEqual(['q_b']);

    const limited = await tool('queryKnowledge').handler({ companyId: 'cq', search: 'alpha', limit: 1 });
    expect(limited.total).toBe(1);
  });

  it('searchKnowledge 全文搜索并支持 projectId 过滤', async () => {
    writeDoc('s_a', { companyId: 'cs', title: 'Kubernetes deploy', projectId: 'px', updatedAt: '2026-01-02T00:00:00.000Z' });
    writeDoc('s_b', { companyId: 'cs', content: 'kubernetes notes', projectId: 'py', updatedAt: '2026-01-03T00:00:00.000Z' });

    const result = await tool('searchKnowledge').handler({ companyId: 'cs', query: 'Kubernetes' });
    expect(result.total).toBe(2);
    expect(result.documents.map((d: any) => d.id)).toEqual(['s_b', 's_a']);
    expect(result.documents[0]).toHaveProperty('projectId');
    expect(result.documents[0]).not.toHaveProperty('content');

    const filtered = await tool('searchKnowledge').handler({ companyId: 'cs', query: 'kubernetes', projectId: 'px' });
    expect(filtered.documents.map((d: any) => d.id)).toEqual(['s_a']);
    expect(tool('searchKnowledge').inputSchema.required).toEqual(['companyId', 'query']);
  });

  it('getMaturity 统计 total/active/archived 与类型分布', async () => {
    writeDoc('m_a', { companyId: 'cm', type: 'design', status: 'active' });
    writeDoc('m_b', { companyId: 'cm', type: 'design', status: 'active' });
    writeDoc('m_c', { companyId: 'cm', type: 'spec', status: 'archived' });
    writeDoc('m_d', { companyId: 'other' });

    const result = await tool('getMaturity').handler({ companyId: 'cm' });
    expect(result).toEqual({
      total: 3,
      active: 2,
      archived: 1,
      archiveRate: '33.3%',
      typeDistribution: { design: 2 },
      healthScore: 20,
      maturityLadder: ['draft', 'candidate', 'validated', 'canonical', 'archived'],
    });
  });
});
