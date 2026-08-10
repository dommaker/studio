/**
 * document-store — 文档 FileStore 存取助手
 *
 * 从 routes.ts 提取（T3 大文件拆分，零行为变更）：
 * DocRecord 模型 + ~/.studio/data/documents 的 list/get/save +
 * ~/.studio/projects 的项目读取。供 documents/internal/search 子路由共享。
 */

import { FileStore } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const fileStore = new FileStore();
const DOCUMENTS_DIR = studioPath('data', 'documents');
const PROJECTS_DIR = studioPath('projects');

export interface DocRecord {
  id: string; projectId: string; companyId: string; type: string;
  title: string; content: string; filePath?: string; tags: string[];
  status: string; version: number; createdBy?: string; updatedBy?: string;
  archivedAt?: string; createdAt: string; updatedAt: string;
}

export async function listDocs(): Promise<DocRecord[]> {
  try {
    const entries = await fs.promises.readdir(DOCUMENTS_DIR, { withFileTypes: true });
    const docs: DocRecord[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const d = await fileStore.readJson<DocRecord>(path.join(DOCUMENTS_DIR, e.name));
      if (d) docs.push(d);
    }
    return docs;
  } catch { return []; }
}

export async function getDoc(id: string): Promise<DocRecord | null> {
  return fileStore.readJson<DocRecord>(path.join(DOCUMENTS_DIR, `${id}.json`));
}

export async function saveDoc(doc: DocRecord): Promise<void> {
  await fs.promises.mkdir(DOCUMENTS_DIR, { recursive: true });
  await fileStore.writeJson(path.join(DOCUMENTS_DIR, `${doc.id}.json`), doc);
}

export async function getProject(projectId: string): Promise<any | null> {
  return fileStore.readJson<any>(path.join(PROJECTS_DIR, `${projectId}.json`));
}

export async function findProjectPmoNumber(projectId: string): Promise<{ pmoNumber?: string; title?: string } | null> {
  const p = await getProject(projectId);
  return p ? { pmoNumber: p.pmoNumber, title: p.title } : null;
}
