/**
 * tool-store 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 ~/.studio/data/* 惰性目录函数与通用 JSON 实体读写助手。
 * 设置 HOME 指向临时目录以隔离真实数据目录（os.homedir() 优先读 HOME）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as store from '../tool-store.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevStudioHome: string | undefined;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tool-store-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  // #219：studioPath() 走 STUDIO_HOME（setup 钉的隔离根），优先于 HOME；
  // 改指本测试的 tmp home，与下方 $HOME/.studio/data/* 断言同根。
  prevStudioHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = path.join(tmpHome, '.studio');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStudioHome === undefined) delete process.env.STUDIO_HOME;
  else process.env.STUDIO_HOME = prevStudioHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('tool-store', () => {
  it('惰性目录函数返回 $HOME/.studio/data/*', () => {
    expect(store.getTasksDir()).toBe(path.join(tmpHome, '.studio', 'data', 'tasks'));
    expect(store.getSpecReviewsDir()).toBe(path.join(tmpHome, '.studio', 'data', 'spec-reviews'));
    expect(store.getCompaniesDir()).toBe(path.join(tmpHome, '.studio', 'data', 'companies'));
  });

  it('generateId 返回唯一字符串', () => {
    const a = store.generateId();
    const b = store.generateId();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });

  it('writeEntity + getEntity 往返一致（自动建目录）', async () => {
    const dir = path.join(tmpHome, '.studio', 'data', 'tasks');
    await store.writeEntity(dir, 't1', { id: 't1', name: 'Task' });
    expect(await store.getEntity(dir, 't1')).toEqual({ id: 't1', name: 'Task' });
  });

  it('getEntity 对不存在的 id 返回 null', async () => {
    expect(await store.getEntity(store.getTasksDir(), 'nope')).toBeNull();
  });

  it('listJsonFiles 目录不存在时返回 []，且忽略非 .json 文件', async () => {
    const missing = path.join(tmpHome, '.studio', 'data', 'no-such-dir');
    expect(await store.listJsonFiles(missing)).toEqual([]);

    const dir = path.join(tmpHome, '.studio', 'data', 'tasks');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    const list = await store.listJsonFiles<{ id: string }>(dir);
    expect(list.map(t => t.id)).toEqual(['t1']);
  });
});
