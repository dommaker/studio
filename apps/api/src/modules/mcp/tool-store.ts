/**
 * MCP Tools 共享 FileStore 存取助手
 *
 * 数据目录约定（~/.studio/data/*）与通用 JSON 实体读写，
 * 供各域 tools 模块（task / knowledge / spec / economy / workunit）共享。
 * T3 拆分：自 tools.ts 原样提取。
 */

import { FileStore } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

// ─── FileStore 存储路径 ───

export const fileStore = new FileStore();
export function getTasksDir(): string {
  return studioPath('data', 'tasks');
}
export function getSpecReviewsDir(): string {
  return studioPath('data', 'spec-reviews');
}
export function getCompaniesDir(): string {
  return studioPath('data', 'companies');
}

// ─── 通用 FileStore 工具 ───

export function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function listJsonFiles<T>(dir: string): Promise<T[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
    const results: T[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<T>(path.join(dir, f.name));
      if (data) results.push(data);
    }
    return results;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function getEntity<T>(dir: string, id: string): Promise<T | null> {
  return fileStore.readJson<T>(path.join(dir, `${id}.json`));
}

export async function writeEntity(dir: string, id: string, data: unknown): Promise<void> {
  await ensureDir(dir);
  await fileStore.writeJson(path.join(dir, `${id}.json`), data);
}
