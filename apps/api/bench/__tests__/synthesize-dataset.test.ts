/**
 * #323 阶段一 bench：数据合成器测试。
 *
 * 计划 §测试：各档规模条目数正确、1x 档与真实数据同构（schema 抽样比对）。
 * 模板目录用 fixture（测试不依赖真实 ~/.studio）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synthesizeDataset } from '../synthesize-dataset.js';

let templateHome: string;
let outHome: string;

const TEMPLATE_WUS = [
  {
    id: 'wu-a', parentId: null, type: 'task', scope: '父任务', assigneeId: 'agent-1',
    status: 'closed', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: 'ch-1', projectPath: null, workspaceId: null, reqId: null,
    metadata: '{"title":"父任务"}', createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z', claimedAt: '2026-08-01T01:00:00.000Z',
    completedAt: '2026-08-02T00:00:00.000Z',
  },
  {
    id: 'wu-b', parentId: 'wu-a', type: 'review', scope: '子评审', assigneeId: null,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: 'ch-1', projectPath: null, workspaceId: null, reqId: null,
    metadata: '{}', createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z', claimedAt: null,
    completedAt: '2026-08-02T00:00:00.000Z',
  },
  {
    id: 'wu-c', parentId: null, type: 'analysis', scope: '分析', assigneeId: null,
    status: 'pending', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, reqId: null,
    metadata: '{}', createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z', claimedAt: null, completedAt: null,
  },
];

function writeFixture(): void {
  const wuDir = path.join(templateHome, 'data', 'workunits');
  fs.mkdirSync(wuDir, { recursive: true });
  fs.writeFileSync(path.join(wuDir, 'index.json'), JSON.stringify(TEMPLATE_WUS, null, 2));

  const logsDir = path.join(templateHome, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'studio-events.jsonl'),
    '{"type":"a","createdAt":"2026-08-01T00:00:00.000Z"}\n{"type":"b","createdAt":"2026-08-01T01:00:00.000Z"}\n');

  // agents：一个有 state+profile 的目录 + 一个空目录（真实数据含大量空实例目录）
  const agentsDir = path.join(templateHome, 'data', 'agents');
  fs.mkdirSync(path.join(agentsDir, 'inst-1'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'inst-1', 'state.json'),
    JSON.stringify({ id: 'inst-1', roleId: 'r1', status: 'idle', pid: 12345, lastHeartbeat: '2026-08-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(agentsDir, 'inst-1', 'profile.json'),
    JSON.stringify({ id: 'inst-1', name: 'dev', status: 'active' }));
  fs.mkdirSync(path.join(agentsDir, 'inst-empty'), { recursive: true });

  const chDir = path.join(templateHome, 'data', 'channels', 'ch-1');
  fs.mkdirSync(chDir, { recursive: true });
  fs.writeFileSync(path.join(chDir, 'config.json'), JSON.stringify({ id: 'ch-1', name: '#系统' }));
  fs.writeFileSync(path.join(chDir, 'messages.jsonl'), '{"id":"m1"}\n');

  const knDir = path.join(templateHome, 'knowledge');
  fs.mkdirSync(knDir, { recursive: true });
  fs.writeFileSync(path.join(knDir, 'entry-1.md'), '# knowledge');
}

beforeEach(() => {
  templateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-template-'));
  outHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-'));
  writeFixture();
});

afterEach(() => {
  fs.rmSync(templateHome, { recursive: true, force: true });
  fs.rmSync(outHome, { recursive: true, force: true });
});

describe('synthesizeDataset', () => {
  it('scale=1：条目数与模板一致 + 注入近 24h 子执行，schema 与模板同构', () => {
    const stats = synthesizeDataset({ templateHome, outHome, scale: 1, recentExecCount: 2 });

    expect(stats.templateWorkUnits).toBe(3);
    expect(stats.workUnits).toBe(3 + 2);
    expect(stats.eventLines).toBe(2);
    expect(stats.agentDirs).toBe(2);
    expect(stats.stateFiles).toBe(1);
    expect(stats.profileFiles).toBe(1);

    const index = JSON.parse(fs.readFileSync(path.join(outHome, 'data', 'workunits', 'index.json'), 'utf-8'));
    expect(index).toHaveLength(5);
    // schema 抽样比对：克隆条目字段集合与模板一致
    const templateKeys = Object.keys(TEMPLATE_WUS[0]).sort();
    expect(Object.keys(index[0]).sort()).toEqual(templateKeys);
    // 注入的子执行：近 24h 完成、parentId 指向已有 WU
    const injected = index.filter((w: any) => w.id.startsWith('bench-exec-'));
    expect(injected).toHaveLength(2);
    const ids = new Set(index.map((w: any) => w.id));
    for (const e of injected) {
      expect(ids.has(e.parentId)).toBe(true);
      expect(e.status).toBe('done');
      expect(Date.now() - new Date(e.completedAt).getTime()).toBeLessThan(24 * 3600_000);
    }
  });

  it('scale=3：WU/事件/agents 三倍复制，id 重映射唯一且 parentId 一致', () => {
    const stats = synthesizeDataset({ templateHome, outHome, scale: 3, recentExecCount: 0 });
    expect(stats.workUnits).toBe(9);
    expect(stats.eventLines).toBe(6);
    expect(stats.agentDirs).toBe(6);
    expect(stats.stateFiles).toBe(3);

    const index = JSON.parse(fs.readFileSync(path.join(outHome, 'data', 'workunits', 'index.json'), 'utf-8'));
    const ids = index.map((w: any) => w.id);
    expect(new Set(ids).size).toBe(9);
    // parentId 重映射一致：wu-b 的克隆指向对应档位的 wu-a 克隆
    for (const w of index) {
      if (w.parentId === null) continue;
      expect(ids).toContain(w.parentId);
    }
    const bX2 = index.find((w: any) => w.id === 'wu-b-x2');
    expect(bX2.parentId).toBe('wu-a-x2');

    // 事件文件行数 ×3
    const lines = fs.readFileSync(path.join(outHome, 'logs', 'studio-events.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(6);

    // agents：state.json 的 id 与目录名一致；pid 置空（避免对宿主机 /proc 的依赖）
    const state = JSON.parse(fs.readFileSync(path.join(outHome, 'data', 'agents', 'inst-1-x2', 'state.json'), 'utf-8'));
    expect(state.id).toBe('inst-1-x2');
    expect(state.pid).toBeNull();

    // channels / knowledge 不随档位放大，原样复制
    expect(fs.existsSync(path.join(outHome, 'data', 'channels', 'ch-1', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(outHome, 'knowledge', 'entry-1.md'))).toBe(true);
  });

  it('不改动模板目录（只读引用）', () => {
    const before = fs.readFileSync(path.join(templateHome, 'data', 'workunits', 'index.json'), 'utf-8');
    synthesizeDataset({ templateHome, outHome, scale: 2, recentExecCount: 1 });
    expect(fs.readFileSync(path.join(templateHome, 'data', 'workunits', 'index.json'), 'utf-8')).toBe(before);
  });

  it('scale>1：事件副本按 12h 偏移，全局时间单调（#335 窗口读口的早停前提）', () => {
    synthesizeDataset({ templateHome, outHome, scale: 3, recentExecCount: 0 });
    const lines = fs.readFileSync(path.join(outHome, 'logs', 'studio-events.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(6);
    // 模板两行 = 2026-08-01T00:00 / 01:00；副本 k 偏移 -k*12h，最旧副本在前
    expect(lines.map((e: any) => e.createdAt)).toEqual([
      '2026-07-31T00:00:00.000Z', '2026-07-31T01:00:00.000Z', // k=2：-24h
      '2026-07-31T12:00:00.000Z', '2026-07-31T13:00:00.000Z', // k=1：-12h
      '2026-08-01T00:00:00.000Z', '2026-08-01T01:00:00.000Z', // k=0：原始
    ]);
  });
});
