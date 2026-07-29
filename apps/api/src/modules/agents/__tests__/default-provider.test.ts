/**
 * F1 default-provider 单测：
 * - resolveDefaultProvider：扫描结果第一个 / 空扫描 → null
 * - backfillProfileProviders：空 provider 的 active 角色打戳；studio/ inactive / 已有 provider 不动；幂等
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { resolveDefaultProvider, backfillProfileProviders } from '../default-provider.js';
import type { DetectedRuntime } from '../../../daemon/cli-scanner.js';

const claudeDetected: DetectedRuntime[] = [{ provider: 'claude', path: '/usr/local/bin/claude', version: '2.1.80' }];

function profile(id: string, name: string, provider: string | null, status = 'active'): AgentProfileData {
  const now = new Date().toISOString();
  return { id, name, description: null, channels: '[]', provider, status, createdAt: now, updatedAt: now };
}

describe('resolveDefaultProvider (F1)', () => {
  it('返回扫描结果第一个 provider', () => {
    expect(resolveDefaultProvider(() => claudeDetected)).toBe('claude');
  });

  it('空扫描 → null（不隐式兜底 claude）', () => {
    expect(resolveDefaultProvider(() => [])).toBeNull();
  });
});

describe('backfillProfileProviders (F1)', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-provider-'));
    fileStore = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('空 provider 的 active 角色打戳；studio/inactive/已有 provider 不动', async () => {
    await fileStore.createProfile(profile('p1', 'dev', null));
    await fileStore.createProfile(profile('p2', 'reviewer', 'kimi'));
    await fileStore.createProfile(profile('p3', 'studio', null));
    await fileStore.createProfile(profile('p4', 'old', null, 'inactive'));

    const stamped = await backfillProfileProviders(fileStore, () => claudeDetected);
    expect(stamped).toBe(1);

    const all = await fileStore.listProfiles();
    expect(all.find(p => p.id === 'p1')!.provider).toBe('claude');
    expect(all.find(p => p.id === 'p2')!.provider).toBe('kimi');
    expect(all.find(p => p.id === 'p3')!.provider).toBeNull(); // studio 不自动打戳
    expect(all.find(p => p.id === 'p4')!.provider).toBeNull(); // inactive 不动
  });

  it('扫不到 CLI → 不动任何角色', async () => {
    await fileStore.createProfile(profile('p1', 'dev', null));
    const stamped = await backfillProfileProviders(fileStore, () => []);
    expect(stamped).toBe(0);
    expect((await fileStore.getProfile('p1'))!.provider).toBeNull();
  });

  it('幂等：第二次运行不再改动', async () => {
    await fileStore.createProfile(profile('p1', 'dev', null));
    await backfillProfileProviders(fileStore, () => claudeDetected);
    const second = await backfillProfileProviders(fileStore, () => claudeDetected);
    expect(second).toBe(0);
  });
});
