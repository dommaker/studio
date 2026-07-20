/**
 * MCP Tools — 知识库（FileStore）
 *
 * T3 拆分：自 tools.ts 原样提取
 * （queryKnowledge / extractKnowledge / storeKnowledge / searchKnowledge / getMaturity）。
 */

import type { RegisteredTool } from './tool-registry.js';
import {
  getDocumentsDir,
  generateId,
  listJsonFiles,
  writeEntity,
} from './tool-store.js';

// ─── 知识库（FileStore） ───

interface DocumentData {
  id: string;
  projectId: string;
  companyId: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  filePath?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const queryKnowledge: RegisteredTool = {
  name: 'queryKnowledge',
  description: '搜索知识库文档',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      search: { type: 'string', description: '搜索关键词' },
      type: { type: 'string', description: '文档类型过滤' },
      limit: { type: 'number', description: '返回数量' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    let docs = await listJsonFiles<DocumentData>(getDocumentsDir());
    docs = docs.filter(d => d.companyId === input.companyId && d.status === 'active');
    if (input.type) docs = docs.filter(d => d.type === input.type);
    if (input.search) {
      const q = input.search.toLowerCase();
      docs = docs.filter(d =>
        d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)
      );
    }
    docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const subset = docs.slice(0, input.limit || 10).map(d => ({
      id: d.id, title: d.title, type: d.type, content: d.content, tags: d.tags, updatedAt: d.updatedAt,
    }));
    return { documents: subset, total: subset.length };
  },
};

const extractKnowledge: RegisteredTool = {
  name: 'extractKnowledge',
  description: '从内容中提取知识条目并存储',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      companyId: { type: 'string', description: '公司 ID' },
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档内容' },
      type: { type: 'string', description: '文档类型', enum: ['requirement', 'design', 'spec', 'execution', 'meeting'] },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    },
    required: ['projectId', 'companyId', 'title', 'content', 'type'],
  },
  handler: async (input) => {
    const id = `doc_${generateId()}`;
    const now = new Date().toISOString();
    const doc: DocumentData = {
      id,
      projectId: input.projectId,
      companyId: input.companyId,
      title: input.title,
      content: input.content,
      type: input.type,
      tags: input.tags || [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await writeEntity(getDocumentsDir(), id, doc);
    return { documentId: doc.id, title: doc.title };
  },
};

const storeKnowledge: RegisteredTool = {
  name: 'storeKnowledge',
  description: '存储知识文档到知识库',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      companyId: { type: 'string', description: '公司 ID' },
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档内容' },
      type: { type: 'string', description: '文档类型', enum: ['requirement', 'design', 'spec', 'execution', 'meeting', 'archive'] },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      filePath: { type: 'string', description: '文件路径（可选）' },
    },
    required: ['projectId', 'companyId', 'title', 'content', 'type'],
  },
  handler: async (input) => {
    const id = `doc_${generateId()}`;
    const now = new Date().toISOString();
    const doc: DocumentData = {
      id,
      projectId: input.projectId,
      companyId: input.companyId,
      title: input.title,
      content: input.content,
      type: input.type,
      tags: input.tags || [],
      filePath: input.filePath,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await writeEntity(getDocumentsDir(), id, doc);
    return { documentId: doc.id, title: doc.title, type: doc.type };
  },
};

const searchKnowledge: RegisteredTool = {
  name: 'searchKnowledge',
  description: '搜索知识库文档（全文搜索）',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      query: { type: 'string', description: '搜索关键词' },
      type: { type: 'string', description: '文档类型过滤' },
      projectId: { type: 'string', description: '项目 ID 过滤' },
      limit: { type: 'number', description: '返回数量', default: 10 },
    },
    required: ['companyId', 'query'],
  },
  handler: async (input) => {
    let docs = await listJsonFiles<DocumentData>(getDocumentsDir());
    const q = input.query.toLowerCase();
    docs = docs.filter(d =>
      d.companyId === input.companyId &&
      d.status === 'active' &&
      (d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q))
    );
    if (input.type) docs = docs.filter(d => d.type === input.type);
    if (input.projectId) docs = docs.filter(d => d.projectId === input.projectId);
    docs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const subset = docs.slice(0, input.limit || 10).map(d => ({
      id: d.id, title: d.title, type: d.type, tags: d.tags, projectId: d.projectId, updatedAt: d.updatedAt,
    }));
    return { documents: subset, total: subset.length };
  },
};

const getMaturity: RegisteredTool = {
  name: 'getMaturity',
  description: '获取知识库成熟度和健康指标',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const docs = await listJsonFiles<DocumentData>(getDocumentsDir());
    const companyDocs = docs.filter(d => d.companyId === input.companyId);
    const total = companyDocs.length;
    const active = companyDocs.filter(d => d.status === 'active').length;
    const archived = companyDocs.filter(d => d.status === 'archived').length;

    const typeDistribution: Record<string, number> = {};
    for (const d of companyDocs) {
      if (d.status === 'active') {
        typeDistribution[d.type] = (typeDistribution[d.type] || 0) + 1;
      }
    }

    return {
      total,
      active,
      archived,
      archiveRate: total > 0 ? (archived / total * 100).toFixed(1) + '%' : '0%',
      typeDistribution,
      healthScore: active > 0 ? Math.min(100, active * 10) : 0,
      maturityLadder: ['draft', 'candidate', 'validated', 'canonical', 'archived'],
    };
  },
};

export const knowledgeTools: RegisteredTool[] = [
  queryKnowledge,
  extractKnowledge,
  storeKnowledge,
  searchKnowledge,
  getMaturity,
];
