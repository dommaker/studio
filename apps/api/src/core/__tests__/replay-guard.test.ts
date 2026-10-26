import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { ReplayGuard } from '../replay-guard.js';

describe('ReplayGuard', () => {
  let dir: string;
  let store: FileStore;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-guard-'));
    store = new FileStore(dir);
    now = Date.now();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('并发同 ID 只有一个原子 claim，锁内裸读可跨 store 实例看到已完成记录', async () => {
    const first = new ReplayGuard(store, { now: () => now });
    const second = new ReplayGuard(new FileStore(dir), { now: () => now });
    const entry = [{ key: 'discord:interaction-1', ttlMs: 60_000 }];

    const results = await Promise.all([first.claim(entry), second.claim(entry)]);
    expect(results.filter(result => result.status === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'replayed')).toHaveLength(1);

    const claimed = results.find(result => result.status === 'claimed')!;
    await first.complete(claimed.token, { type: 1 });

    const restarted = new ReplayGuard(new FileStore(dir), { now: () => now });
    await expect(restarted.claim(entry)).resolves.toEqual({ status: 'replayed', response: { type: 1 } });
    const stat = fs.statSync(path.join(dir, 'webhook-replays.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('处理失败释放 processing 占位，同 ID 可重试', async () => {
    const guard = new ReplayGuard(store, { now: () => now });
    const entry = [{ key: 'deploy:delivery-1', ttlMs: 60_000 }];
    const claim = await guard.claim(entry);
    expect(claim.status).toBe('claimed');

    await guard.release(claim.token);

    const retry = await guard.claim(entry);
    expect(retry.status).toBe('claimed');
    expect(retry.token).not.toBe(claim.token);
  });

  it('TTL 到期后同 ID 可再次处理，并在新 claim 时清理过期项', async () => {
    const guard = new ReplayGuard(store, { now: () => now });
    const entry = [{ key: 'discord:interaction-ttl', ttlMs: 1_000 }];
    const claim = await guard.claim(entry);
    await guard.complete(claim.token);
    await expect(guard.claim(entry)).resolves.toMatchObject({ status: 'replayed' });

    now += 1_001;
    const renewed = await guard.claim(entry);
    expect(renewed.status).toBe('claimed');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'webhook-replays.json'), 'utf8'));
    expect(Object.keys(persisted.entries)).toEqual(['discord:interaction-ttl']);
  });

  it('processing 跨重启且超过旧租约仍不自动重新执行', async () => {
    const guard = new ReplayGuard(store, { now: () => now });
    const entry = [{ key: 'deploy:commit-processing', ttlMs: null }];
    await guard.claim(entry);

    now += 24 * 60 * 60 * 1000 + 1;
    const restarted = new ReplayGuard(new FileStore(dir), { now: () => now });
    await expect(restarted.claim(entry)).resolves.toMatchObject({ status: 'replayed' });
  });
});
