/**
 * files.routes 路由测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 挂载 filesRoutes 到 express app，覆盖：
 * GET /requirements（扫描 KNOWLEDGE_BASE_PATH，需求文档优先排序）、
 * POST /read-file（400/403/404/格式检查/成功读取）、
 * GET /file（KNOWLEDGE_BASE_PATH 边界 403/404/200）。
 * 通过 KNOWLEDGE_BASE_PATH / ALLOWED_DIRS 环境变量指向临时目录隔离真实文件。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { filesRoutes } from '../files.routes.js';

let tmpDir: string;
let kbDir: string;
let allowedDir: string;
let server: Server;
let base: string;
let prevKb: string | undefined;
let prevAllowed: string | undefined;

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-files-routes-'));
  kbDir = path.join(tmpDir, 'kb');
  allowedDir = path.join(tmpDir, 'allowed');
  fs.mkdirSync(path.join(kbDir, 'projA'), { recursive: true });
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'projA', '需求-登录.md'), '# 登录需求');
  fs.writeFileSync(path.join(kbDir, 'projA', 'notes.md'), '# 笔记');
  fs.writeFileSync(path.join(kbDir, 'projA', 'skip.txt'), 'not md');
  fs.writeFileSync(path.join(allowedDir, 'ok.md'), '允许的内容');

  prevKb = process.env.KNOWLEDGE_BASE_PATH;
  prevAllowed = process.env.ALLOWED_DIRS;
  process.env.KNOWLEDGE_BASE_PATH = kbDir;
  process.env.ALLOWED_DIRS = allowedDir;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/knowledge', filesRoutes);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/knowledge`;
});

afterAll(async () => {
  if (prevKb === undefined) delete process.env.KNOWLEDGE_BASE_PATH;
  else process.env.KNOWLEDGE_BASE_PATH = prevKb;
  if (prevAllowed === undefined) delete process.env.ALLOWED_DIRS;
  else process.env.ALLOWED_DIRS = prevAllowed;
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('files.routes', () => {
  it('GET /requirements scans md files, requirement docs first', async () => {
    const res = await api('GET', '/requirements');
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.docs[0].name).toBe('需求-登录.md');
    expect(res.json.docs[0].isRequirement).toBe(true);
    expect(res.json.docs[0].project).toBe('projA');
    expect(res.json.docs[1].name).toBe('notes.md');
    expect(res.json.docs[1].isRequirement).toBe(false);
  });

  it('POST /read-file 400 without filePath', async () => {
    const res = await api('POST', '/read-file', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Missing filePath');
  });

  it('POST /read-file 403 outside allowed dirs', async () => {
    const res = await api('POST', '/read-file', { filePath: '/etc/hostname.md' });
    expect(res.status).toBe(403);
  });

  it('POST /read-file 400 for unsupported extension', async () => {
    fs.writeFileSync(path.join(allowedDir, 'x.exe'), 'bin');
    const res = await api('POST', '/read-file', { filePath: path.join(allowedDir, 'x.exe') });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('只支持');
  });

  it('POST /read-file 404 for missing file', async () => {
    const res = await api('POST', '/read-file', { filePath: path.join(allowedDir, 'missing.md') });
    expect(res.status).toBe(404);
  });

  it('POST /read-file 200 reads file content (relative path resolved against first allowed dir)', async () => {
    const res = await api('POST', '/read-file', { filePath: 'ok.md' });
    expect(res.status).toBe(200);
    expect(res.json.content).toBe('允许的内容');
    expect(res.json.ext).toBe('.md');
    expect(res.json.size).toBeGreaterThan(0);
  });

  it('GET /file 400 without path, 403 outside kb, 404 missing, 200 reads', async () => {
    expect((await api('GET', '/file')).status).toBe(400);
    expect((await api('GET', `/file?path=${encodeURIComponent(path.join(allowedDir, 'ok.md'))}`)).status).toBe(403);
    expect((await api('GET', `/file?path=${encodeURIComponent(path.join(kbDir, 'nope.md'))}`)).status).toBe(404);
    const ok = await api('GET', `/file?path=${encodeURIComponent(path.join(kbDir, 'projA', 'notes.md'))}`);
    expect(ok.status).toBe(200);
    expect(ok.json.content).toBe('# 笔记');
  });
});
