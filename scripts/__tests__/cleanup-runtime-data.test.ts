/**
 * cleanup-runtime-data.ts — F3 运行时数据清洗脚本测试
 *
 * 在 tmp STUDIO_CONFIG_DIR（--root）上构造 fixture：
 * active/inactive/malformed/缺失 profile、孤儿 state、DB 残留、events 合并、knowledge 测试污染。
 * 验证 dry-run 不改盘、apply 归档可恢复。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runCleanup, formatSummary, type CleanupSummary } from '../cleanup-runtime-data';

interface Fixture {
  root: string;        // tmp 根
  studioRoot: string;  // tmp/.studio
  repoRoot: string;    // tmp/repo
  agentsDir: string;
}

function makeProfile(id: string, status: string, channels: string): string {
  const now = new Date().toISOString();
  return JSON.stringify({ id, name: `agent-${id}`, description: null, channels, status, provider: null, createdAt: now, updatedAt: now });
}

function makeState(id: string, roleId: string): string {
  const now = new Date().toISOString();
  return JSON.stringify({ id, roleId, sessionId: null, status: 'terminated', currentWorkUnitId: null, startedAt: now, terminatedAt: now, lastHeartbeat: null, metadata: null });
}

function buildFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
  const studioRoot = path.join(root, '.studio');
  const repoRoot = path.join(root, 'repo');
  const agentsDir = path.join(studioRoot, 'data', 'agents');

  const writeAgent = (dir: string, filename: string, content: string) => {
    fs.mkdirSync(path.join(agentsDir, dir), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, dir, filename), content);
  };

  // a: active（channels 双重编码，待迁移）
  writeAgent('p-active', 'profile.json', makeProfile('p-active', 'active', JSON.stringify(JSON.stringify(['ch-1']))));
  // b: inactive → 归档
  writeAgent('p-inactive', 'profile.json', makeProfile('p-inactive', 'inactive', '[]'));
  // c: malformed profile → 归档
  writeAgent('p-malformed', 'profile.json', '{bad json');
  // d: profile 缺失（仅有 state.json）→ 归档
  writeAgent('p-no-profile', 'state.json', makeState('p-no-profile', 'p-active'));
  // e: active + 孤儿 state（roleId 不存在）→ state 归档
  writeAgent('p-active-orphan-state', 'profile.json', makeProfile('p-active-orphan-state', 'active', '[]'));
  writeAgent('p-active-orphan-state', 'state.json', makeState('s-orphan', 'p-gone'));
  // f: active + 正常 state → 都保留
  writeAgent('p-active-good-state', 'profile.json', makeProfile('p-active-good-state', 'active', '["ch-9"]'));
  writeAgent('p-active-good-state', 'state.json', makeState('s-good', 'p-active-good-state'));

  // c: DB 残留
  fs.writeFileSync(path.join(studioRoot, 'data.db'), '');
  fs.writeFileSync(path.join(studioRoot, 'data', 'data.db'), '');
  fs.writeFileSync(path.join(studioRoot, 'data', 'studio.db'), '');
  fs.writeFileSync(path.join(studioRoot, 'data', 'data.db.bak.20260630_204504'), '');

  // d: events 合并（L3 与目标重复；L2 源内重复）
  fs.mkdirSync(path.join(root, 'events'), { recursive: true });
  fs.writeFileSync(path.join(root, 'events', 'studio.jsonl'), '{"n":1}\n{"n":2}\n{"n":2}\n{"n":3}\n');
  fs.writeFileSync(path.join(root, 'events', 'other.jsonl'), '{"x":1}\n');
  fs.mkdirSync(path.join(studioRoot, 'events'), { recursive: true });
  fs.writeFileSync(path.join(studioRoot, 'events', 'studio.jsonl'), '{"n":3}\n');

  // e: knowledge 测试污染
  const knowledgeDir = path.join(repoRoot, '.harness', 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(path.join(knowledgeDir, 'guideline-test-lq-1.md'), 'test');
  fs.writeFileSync(path.join(knowledgeDir, 'guideline-test-lq-2.md'), 'test');
  fs.writeFileSync(path.join(knowledgeDir, 'keep.md'), 'keep');
  fs.writeFileSync(path.join(knowledgeDir, 'index.json'), JSON.stringify([
    { id: 'keep', path: 'keep.md' },
    { id: 'guideline-test-lq-1', path: 'guideline-test-lq-1.md' },
  ]));

  return { root, studioRoot, repoRoot, agentsDir };
}

describe('cleanup-runtime-data', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = buildFixture();
  });

  afterEach(() => {
    fs.rmSync(fx.root, { recursive: true, force: true });
  });

  it('dry-run 报告正确且不改盘', async () => {
    const summary = await runCleanup({ studioRoot: fx.studioRoot, repoRoot: fx.repoRoot, apply: false });

    expect(summary.mode).toBe('dry-run');
    // a: 3 个归档（inactive / malformed / missing），3 个 active 保留
    expect(summary.agentDirsArchived.map(a => a.id).sort()).toEqual(['p-inactive', 'p-malformed', 'p-no-profile']);
    expect(summary.agentDirsKept.sort()).toEqual(['p-active', 'p-active-good-state', 'p-active-orphan-state']);
    // b: 1 个孤儿 state
    expect(summary.orphanStatesArchived).toHaveLength(1);
    expect(summary.orphanStatesArchived[0].dir).toBe('p-active-orphan-state');
    // c: 4 个 DB 文件
    expect(summary.dbFilesArchived.sort()).toEqual(['data.db', 'data/data.db', 'data/data.db.bak.20260630_204504', 'data/studio.db'].sort());
    // d: 4 行源 → 2 行新增（n:1, n:2），2 行重复（n:2 内部重复 + n:3 与目标重复）
    expect(summary.events.sourceExists).toBe(true);
    expect(summary.events.sourceLines).toBe(4);
    expect(summary.events.mergedLines).toBe(2);
    expect(summary.events.duplicateLines).toBe(2);
    expect(summary.events.othersLeftInPlace).toEqual(['other.jsonl']);
    // e
    expect(summary.knowledge.testFilesRemoved).toBe(2);
    expect(summary.knowledge.indexEntriesRemoved).toBe(1);
    // f: dry-run 时目录尚未归档，迁移会扫到全部可读 profile（含 inactive）；1 个双编码待重写
    expect(summary.channelsMigration).toEqual({ scanned: 4, rewritten: 1 });

    // 不改盘
    expect(fs.existsSync(path.join(fx.agentsDir, 'p-inactive'))).toBe(true);
    expect(fs.existsSync(summary.backupDir)).toBe(false);
    expect(fs.readFileSync(path.join(fx.studioRoot, 'events', 'studio.jsonl'), 'utf-8')).toBe('{"n":3}\n');
    expect(fs.existsSync(path.join(fx.root, 'events', 'studio.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(fx.repoRoot, '.harness', 'knowledge', 'guideline-test-lq-1.md'))).toBe(true);
    const profile = JSON.parse(fs.readFileSync(path.join(fx.agentsDir, 'p-active', 'profile.json'), 'utf-8'));
    expect(profile.channels).toBe(JSON.stringify(JSON.stringify(['ch-1'])));

    // formatSummary 不抛错且包含关键行
    const text = formatSummary(summary);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('归档 3 个');
  });

  it('apply 归档全部目标并可恢复', async () => {
    const summary: CleanupSummary = await runCleanup({ studioRoot: fx.studioRoot, repoRoot: fx.repoRoot, apply: true });

    expect(summary.mode).toBe('apply');
    // a: 原位置只剩 3 个 active 目录
    expect(fs.readdirSync(fx.agentsDir).sort()).toEqual(['p-active', 'p-active-good-state', 'p-active-orphan-state']);
    // 归档目录完整可恢复
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'agents', 'p-inactive', 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'agents', 'p-no-profile', 'state.json'))).toBe(true);
    // b: 孤儿 state 已归档，正常 state 保留
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'agents', 'p-active-orphan-state', 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(fx.agentsDir, 'p-active-orphan-state', 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(fx.agentsDir, 'p-active-good-state', 'state.json'))).toBe(true);
    // c: DB 残留已归档
    expect(fs.existsSync(path.join(fx.studioRoot, 'data.db'))).toBe(false);
    expect(fs.existsSync(path.join(summary.backupDir, 'data.db'))).toBe(true);
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'data.db'))).toBe(true);
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'data.db.bak.20260630_204504'))).toBe(true);
    expect(fs.existsSync(path.join(summary.backupDir, 'data', 'studio.db'))).toBe(true);
    // d: 合并去重后追加，源文件归档，other.jsonl 不动
    const merged = fs.readFileSync(path.join(fx.studioRoot, 'events', 'studio.jsonl'), 'utf-8');
    expect(merged).toBe('{"n":3}\n{"n":1}\n{"n":2}\n');
    expect(fs.existsSync(path.join(fx.root, 'events', 'studio.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(summary.backupDir, 'home-events', 'studio.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(fx.root, 'events', 'other.jsonl'))).toBe(true);
    // e: 测试污染文件归档，keep.md 与 index.json 保留条目正确
    expect(fs.existsSync(path.join(fx.repoRoot, '.harness', 'knowledge', 'guideline-test-lq-1.md'))).toBe(false);
    expect(fs.existsSync(path.join(summary.backupDir, 'repo', '.harness', 'knowledge', 'guideline-test-lq-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(fx.repoRoot, '.harness', 'knowledge', 'keep.md'))).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(fx.repoRoot, '.harness', 'knowledge', 'index.json'), 'utf-8'));
    expect(index).toEqual([{ id: 'keep', path: 'keep.md' }]);
    // f: channels 已归一化
    const profile = JSON.parse(fs.readFileSync(path.join(fx.agentsDir, 'p-active', 'profile.json'), 'utf-8'));
    expect(profile.channels).toBe('["ch-1"]');
    // status 等其他字段不动
    expect(profile.status).toBe('active');
  });

  it('空数据根目录安全跑通', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-empty-'));
    try {
      const summary = await runCleanup({
        studioRoot: path.join(emptyRoot, '.studio'),
        repoRoot: path.join(emptyRoot, 'repo'),
        apply: true,
      });
      expect(summary.agentDirsArchived).toHaveLength(0);
      expect(summary.events.sourceExists).toBe(false);
      expect(summary.channelsMigration).toEqual({ scanned: 0, rewritten: 0 });
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});
