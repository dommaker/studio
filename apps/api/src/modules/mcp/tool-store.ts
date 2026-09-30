/**
 * MCP Tools 共享 FileStore 存取助手
 *
 * 数据目录约定（~/.studio/data/*）与通用 JSON 实体读写，
 * 供各域 tools 模块（task / knowledge / spec / economy / workunit）共享。
 * T3 拆分：自 tools.ts 原样提取。
 */

import { FileStore } from '@dommaker/studio-shared';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../core/store.js';


// ─── FileStore 存储路径 ───

// 导出的共享实例 = 测试 mock 锚点（channel.tools 等 6 个消费方的单测 vi.mock 本模块）。
// 形态为例外保留的模块级捕获（P2-b 一般规则禁模块级捕获）；实例来自 getStore()，
// 与调用时获取同一进程级单例，无第二实例。
export const fileStore = getStore();

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
//
// #362 单点化：枚举/读/写全部委托 FileStore 原语（listJsonInDir / readJson / writeJson），
// 不再自持 readdir + .json 过滤副本。writeJson 自带 ensureDir，无需本地建目录。

export async function listJsonFiles<T>(dir: string): Promise<T[]> {
  return getStore().listJsonInDir<T>(dir);
}

export async function getEntity<T>(dir: string, id: string): Promise<T | null> {
  return getStore().readJson<T>(path.join(dir, `${id}.json`));
}

export async function writeEntity(dir: string, id: string, data: unknown): Promise<void> {
  await getStore().writeJson(path.join(dir, `${id}.json`), data);
}
