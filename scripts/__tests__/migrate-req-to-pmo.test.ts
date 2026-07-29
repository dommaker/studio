/**
 * migrate-req-to-pmo.ts — REQ → PMO 存量迁移脚本测试（决策 4 修正版）
 *
 * 在 tmp studioHome 上构造 fixture：
 * 已挂接/未挂接/断裂 REQ、新旧格式 PMO、编号越界冲突、reqAlias 同号校验。
 * 验证 dry-run 不写盘、apply 落盘映射、冲突时 apply 拒绝落盘。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runMigration } from '../migrate-req-to-pmo';

let home: string;

function writeReq(id: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(home, 'data', 'requirements');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, title: `t-${id}`, status: 'open', ...extra }));
}

function writeProject(id: string, extra: Record<string, unknown> = {}) {
  const dir = path.join(home, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, pmoNumber: 'PM-001', title: `p-${id}`, status: 'pending', ...extra }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'req-pmo-migrate-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('runMigration（决策 4 修正版）', () => {
  it('dry-run：报告分层（已挂接/未挂接/统一起点），不写盘', () => {
    writeReq('REQ-0001', { projectId: 'proj-a' });
    writeReq('REQ-0004', { title: '孤儿需求' });
    writeProject('proj-a', { pmoNumber: 'PM-001' });

    const r = runMigration({ studioHome: home });
    expect(r.mapping).toEqual({ 'REQ-0001': 'proj-a' });
    expect(r.unmapped).toEqual(['REQ-0004']);
    expect(r.unifiedStart).toBe(5); // max(REQ 4, PM 1)+1
    expect(r.conflicts).toEqual([]);
    expect(r.lines.join('\n')).toContain('dry-run');
    expect(fs.existsSync(path.join(home, 'data', 'req-pmo-map.json'))).toBe(false);
  });

  it('apply：落盘 req-pmo-map.json（mapping + unmapped + unifiedStart）', () => {
    writeReq('REQ-0002', { projectId: 'proj-a' });
    writeReq('REQ-0007');
    writeProject('proj-a', { pmoNumber: 'PMO-9' });

    const r = runMigration({ studioHome: home, apply: true });
    expect(r.conflicts).toEqual([]);
    const map = JSON.parse(fs.readFileSync(path.join(home, 'data', 'req-pmo-map.json'), 'utf-8'));
    expect(map.mapping).toEqual({ 'REQ-0002': 'proj-a' });
    expect(map.unmapped).toEqual(['REQ-0007']);
    expect(map.unifiedStart).toBe(10); // max(REQ 7, PMO 9)+1
  });

  it('挂接断裂（projectId 指向不存在项目）→ broken 报告', () => {
    writeReq('REQ-0003', { projectId: 'proj-ghost' });
    const r = runMigration({ studioHome: home });
    expect(r.broken.length).toBe(1);
    expect(r.broken[0].reqId).toBe('REQ-0003');
    expect(r.lines.join('\n')).toContain('挂接断裂');
  });

  it('reqAlias 与 pmoNumber 不同号 → 冲突，apply 拒绝落盘', () => {
    writeProject('proj-x', { pmoNumber: 'PMO-5', reqAlias: 'REQ-0007' });
    writeReq('REQ-0001');

    const r = runMigration({ studioHome: home, apply: true });
    expect(r.conflicts.some(c => c.includes('不同号'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'data', 'req-pmo-map.json'))).toBe(false);
    expect(r.lines.join('\n')).toContain('中止落盘');
  });

  it('REQ 序号取 max(seq 字段, 文件名)（空洞序号也纳入统一起点）', () => {
    writeReq('REQ-0002', { seq: 9 });
    writeProject('proj-x', { pmoNumber: 'PM-002' });

    const r = runMigration({ studioHome: home });
    expect(r.unifiedStart).toBe(10); // max(REQ seq 9, PM 2)+1
  });

  it('空目录 → 统一起点 1，报告齐全不抛错', () => {
    const r = runMigration({ studioHome: home });
    expect(r.unifiedStart).toBe(1);
    expect(r.mapping).toEqual({});
    expect(r.unmapped).toEqual([]);
    expect(r.lines.join('\n')).toContain('（无）');
  });
});
