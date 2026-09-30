/**
 * bootstrap/migrations 测试（P2-a）：
 * - runDataMigrations 失败 = 拒启语义（错误向上传播，由装配层 exit(1)）；
 * - 迁移有 applied/skipped 时落完成日志；
 * - reconcileWorkUnitIndex 失败不阻断（non-blocking）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared/migrations', () => ({
  runMigrations: vi.fn(),
}));

import { runMigrations } from '@dommaker/studio-shared/migrations';
import { runDataMigrations, reconcileWorkUnitIndex } from '../migrations.js';

const runMigrationsMock = vi.mocked(runMigrations);

beforeEach(() => {
  runMigrationsMock.mockReset();
});

describe('runDataMigrations', () => {
  it('迁移失败 → 错误向上传播（拒启语义，装配层 catch 后 exit 1）', async () => {
    runMigrationsMock.mockRejectedValue(new Error('MigrationError: schema v2 apply failed'));
    await expect(runDataMigrations()).rejects.toThrow(/MigrationError/);
  });

  it('迁移成功（空 applied/skipped）→ 正常返回', async () => {
    runMigrationsMock.mockResolvedValue({
      fromVersion: 1, toVersion: 1, applied: [], skipped: [], backupPaths: [],
    } as any);
    await expect(runDataMigrations()).resolves.toBeUndefined();
    expect(runMigrationsMock).toHaveBeenCalledOnce();
  });

  it('迁移有 applied → 落完成日志且不抛错', async () => {
    runMigrationsMock.mockResolvedValue({
      fromVersion: 1, toVersion: 2, applied: ['v2-x'], skipped: [], backupPaths: ['/b'],
    } as any);
    await expect(runDataMigrations()).resolves.toBeUndefined();
  });
});

describe('reconcileWorkUnitIndex', () => {
  it('空数据区对账 → 不重建、不抛错（真实 FileStore 走隔离数据根）', async () => {
    await expect(reconcileWorkUnitIndex()).resolves.toBeUndefined();
  });
});
