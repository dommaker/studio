/**
 * #572 / 契约 §5（docs/architecture/data-directory-contract.md）：数据区版本标记 + 迁移框架。
 *
 * 验收口径（票体 + 冻结决议逐条）：
 * - 全新数据区 → 顺序迁移到当前版本；SEC-09 v2 建立 0600 重放台账；已有当前版本 → no-op
 * - 模拟迁移失败 → 拒启（MigrationError）+ 备份存在 + 错误含备份路径与回滚指引
 * - 幂等：重复执行结果不变（探针判已应用）
 * - 可重入：中断（apply 已生效、manifest 未抬版）后重跑，探针跳过不重复执行
 * - 备份范围：只备 data/ 与根级 JSON/jsonl；logs/、worktrees/ 不备；既有 .bak-* 不再二次备份
 * - 单条迁移原子：写临时文件 + rename，不残留 tmp 文件
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runMigrations,
  readSchemaVersion,
  backupDataArea,
  manifestPath,
  MigrationError,
  MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  type Migration,
} from '../index';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-migrations-'));
}

function readManifest(root: string): { schemaVersion: number; updatedAt: string } {
  return JSON.parse(fs.readFileSync(manifestPath(root), 'utf-8'));
}

function rootEntries(root: string): string[] {
  return fs.readdirSync(root);
}

const BAK_RE = /\.bak-\d{8}-\d{6}(-\d+)?$/;

afterEach(() => {
  vi.unstubAllEnvs();
});

// 根仓 vitest 的 packages project 经 setup-isolated-data.setup.ts 全局钉 STUDIO_DATA_DIR
// 到共享隔离根；本文件每个用例自带 rootDir，须把 data 根收回 <root>/data 才确定。
beforeEach(() => {
  vi.stubEnv('STUDIO_DATA_DIR', undefined);
});

describe('readSchemaVersion', () => {
  it('无 manifest = v0（现存全部数据区）', async () => {
    const root = mkRoot();
    expect(await readSchemaVersion(root)).toBe(0);
  });

  it('manifest 损坏 → 拒启（不静默当 v0 重迁移）', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(manifestPath(root), 'not-json{{{');
    await expect(readSchemaVersion(root)).rejects.toThrow(MigrationError);
  });
});

describe('数据区默认迁移链', () => {
  it('全新数据区：顺序迁移到当前版本并建立重放台账与投影目录', async () => {
    const root = mkRoot();
    const result = await runMigrations(root);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(9);
    expect(result.applied).toEqual(['v1-empty-manifest', 'v2-webhook-replay-ledger', 'v3-workunit-current-projection', 'v4-read-model-projections', 'v5-delivery-leg-locks', 'v6-effect-receipts', 'v7-role-memory-maintenance', 'v8-pmo-candidate-review', 'v9-knowledge-outcomes']);
    expect(readManifest(root).schemaVersion).toBe(9);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    expect(MIGRATIONS).toHaveLength(9);
    const ledger = path.join(root, 'data', 'webhook-replays.json');
    expect(JSON.parse(fs.readFileSync(ledger, 'utf8'))).toEqual({ version: 1, entries: {} });
    expect(fs.statSync(ledger).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, 'data', 'workunits', 'current')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'logs', 'projections')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'worktrees', '.delivery-locks')).mode & 0o777).toBe(0o700);
  });

  it('已有当前 manifest → no-op：不重复 apply、不产生新备份、manifest 不变', async () => {
    const root = mkRoot();
    await runMigrations(root);
    const before = fs.readFileSync(manifestPath(root), 'utf-8');
    const entriesBefore = rootEntries(root);

    const second = await runMigrations(root);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.backupPaths).toEqual([]);
    expect(second.fromVersion).toBe(9);
    expect(second.toVersion).toBe(9);
    expect(fs.readFileSync(manifestPath(root), 'utf-8')).toBe(before);
    expect(rootEntries(root)).toEqual(entriesBefore);
  });

  it('manifest 写盘原子：结束后无 tmp 残留，manifest 可解析', async () => {
    const root = mkRoot();
    await runMigrations(root);
    const dataEntries = fs.readdirSync(path.join(root, 'data'));
    expect(dataEntries.filter((e) => e.includes('.tmp-'))).toEqual([]);
    expect(() => readManifest(root)).not.toThrow();
  });

  it('STUDIO_DATA_DIR 覆盖时 manifest 落在覆盖后的 data 根（与 FileStore baseDir 同口径）', async () => {
    const root = mkRoot();
    const dataOverride = path.join(root, 'custom-data');
    vi.stubEnv('STUDIO_DATA_DIR', dataOverride);
    await runMigrations(root);
    expect(fs.existsSync(path.join(dataOverride, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'manifest.json'))).toBe(false);
  });
});

describe('失败拒启 + 备份（契约 §5 四性质）', () => {
  const failingV10: Migration = {
    version: 10,
    name: 'v10-boom',
    isApplied: () => false,
    apply: async () => {
      throw new Error('boom');
    },
  };

  function seedV1Area(root: string): void {
    fs.mkdirSync(path.join(root, 'data', 'channels'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'channels', 'c1.json'), '{}');
    fs.writeFileSync(path.join(root, 'users.json'), '[]');
    fs.writeFileSync(path.join(root, 'sessions.jsonl'), '{"a":1}\n');
    // 可再生产物：不属于备份范围
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'studio-events.jsonl'), '{}\n');
    fs.mkdirSync(path.join(root, 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'worktrees', 'w1', 'f'), 'x');
    // 既有手工备份：不再二次备份
    fs.writeFileSync(path.join(root, 'users.json.bak-20200101-000000'), '[]');
  }

  it('迁移失败 → MigrationError 拒启，错误含备份路径与回滚指引，manifest 保持当前版本', async () => {
    const root = mkRoot();
    seedV1Area(root);
    await runMigrations(root);

    const err = await runMigrations(root, { migrations: [...MIGRATIONS, failingV10] }).catch((e) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.message).toContain('v10-boom');
    expect(err.message).toContain('boom');
    expect(err.message).toContain('回滚');
    expect(err.backupPaths.length).toBeGreaterThan(0);
    for (const p of err.backupPaths) {
      expect(fs.existsSync(p)).toBe(true);
      expect(err.message).toContain(p);
    }
    // 不留半迁移态：manifest 仍是当前版本
    expect(readManifest(root).schemaVersion).toBe(9);
  });

  it('备份范围：只备 data/ 与根级 JSON/jsonl；logs/、worktrees/、既有 .bak-* 不备', async () => {
    const root = mkRoot();
    seedV1Area(root);
    await runMigrations(root);

    const backups = rootEntries(root).filter((e) => BAK_RE.test(e));
    // data 整目录 + 两个根级数据文件；既有 .bak 不二次备份
    expect(backups.some((e) => e.startsWith('data.bak-'))).toBe(true);
    expect(backups.some((e) => e.startsWith('users.json.bak-') && e !== 'users.json.bak-20200101-000000')).toBe(true);
    expect(backups.some((e) => e.startsWith('sessions.jsonl.bak-'))).toBe(true);
    expect(backups.some((e) => e.startsWith('logs'))).toBe(false);
    expect(backups.some((e) => e.startsWith('worktrees'))).toBe(false);
    expect(backups.some((e) => e.startsWith('users.json.bak-20200101-000000.bak-'))).toBe(false);

    // 备份内容完整：data 子树文件在备份里
    const dataBak = backups.find((e) => e.startsWith('data.bak-'))!;
    expect(fs.existsSync(path.join(root, dataBak, 'channels', 'c1.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, dataBak, 'manifest.json'))).toBe(false); // v0 备份无 manifest
  });

  it('备份命名沿用数据区先例：.bak-<YYYYMMDD-HHMMSS>', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'x.json'), '{}');
    const backups = await backupDataArea(root);
    expect(backups.length).toBeGreaterThan(0);
    for (const p of backups) expect(p).toMatch(BAK_RE);
  });
});

describe('幂等 / 可重入', () => {
  it('探针判已应用：中断在 apply 之后、manifest 抬版之前，重跑跳过 apply 只抬版本', async () => {
    const root = mkRoot();
    await runMigrations(root);

    let applyCalls = 0;
    const markerV10: Migration = {
      version: 10,
      name: 'v10-marker',
      isApplied: (rootDir) => fs.existsSync(path.join(rootDir, 'data', 'v10-marker')),
      apply: async (rootDir) => {
        applyCalls++;
        fs.writeFileSync(path.join(rootDir, 'data', 'v10-marker'), '1');
      },
    };

    // 模拟中断现场：v10 的 apply 效果已落盘，manifest 仍是当前版本
    fs.writeFileSync(path.join(root, 'data', 'v10-marker'), '1');

    const result = await runMigrations(root, { migrations: [...MIGRATIONS, markerV10] });
    expect(applyCalls).toBe(0); // 探针命中，不重复执行
    expect(result.skipped).toEqual(['v10-marker']);
    expect(result.applied).toEqual([]);
    expect(readManifest(root).schemaVersion).toBe(10);
  });

  it('正常执行新迁移：apply 恰执行一次，重复运行整体 no-op', async () => {
    const root = mkRoot();
    let applyCalls = 0;
    const markerV10: Migration = {
      version: 10,
      name: 'v10-marker',
      isApplied: (rootDir) => fs.existsSync(path.join(rootDir, 'data', 'v10-marker')),
      apply: async (rootDir) => {
        applyCalls++;
        fs.writeFileSync(path.join(rootDir, 'data', 'v10-marker'), '1');
      },
    };
    const chain = [...MIGRATIONS, markerV10];

    const first = await runMigrations(root, { migrations: chain });
    expect(first.applied).toEqual(['v1-empty-manifest', 'v2-webhook-replay-ledger', 'v3-workunit-current-projection', 'v4-read-model-projections', 'v5-delivery-leg-locks', 'v6-effect-receipts', 'v7-role-memory-maintenance', 'v8-pmo-candidate-review', 'v9-knowledge-outcomes', 'v10-marker']);
    expect(applyCalls).toBe(1);
    expect(readManifest(root).schemaVersion).toBe(10);

    const second = await runMigrations(root, { migrations: chain });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.backupPaths).toEqual([]);
    expect(applyCalls).toBe(1); // 幂等：不重复执行
  });
});
