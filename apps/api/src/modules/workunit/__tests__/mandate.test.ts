import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { workUnitSchema } from '@dommaker/studio-contract';
import { WorkUnitService } from '../workunit-review.js';
import { toWorkUnitWire } from '../workunit-crud.js';

const operator = { id: 'operator-1', type: 'Operator' } as const;

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-mandate-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('WorkUnit Mandate 授权', () => {
  it('建单固定服务端请求人、来源、血缘、范围、交付权限、预算和策略版本', async () => {
    const created = await service.create({
      scope: '实现授权模型',
      type: 'task',
      status: 'unassigned',
      channelId: 'channel-1',
      reqId: 'REQ-0001',
      metadata: {
        pmoId: 'pmo-1',
        workspaceRoot: '/repo/studio',
        pmoBranch: 'pmo/PMO-1/api',
        tokenBudget: 50_000,
        planStepAllowance: 60,
      },
      authorization: {
        requestedBy: operator,
        source: { kind: 'channel', channelId: 'channel-1', messageId: 'message-1' },
      },
    });

    expect(created.mandate).toMatchObject({
      workUnitId: created.id,
      revision: 1,
      policyVersion: '1',
      requestedBy: operator,
      grantedBy: operator,
      source: { kind: 'channel', channelId: 'channel-1', messageId: 'message-1' },
      reqId: 'REQ-0001',
      pmoId: 'pmo-1',
      repositories: [{ repo: '/repo/studio', leg: 'pmo/PMO-1/api' }],
      deliveryActions: ['merge', 'deliver', 'mark-delivered'],
      budget: { tokens: 50_000, planSteps: 60 },
    });
    expect(created.mandate?.grantedAt).toEqual(expect.any(String));
    expect(workUnitSchema.parse(toWorkUnitWire(created)).mandate?.requestedBy).toEqual(operator);

    await store.rebuildIndex();
    expect((await service.getById(created.id))?.mandate).toEqual(created.mandate);
  });

  it('普通新 WU 在认领前按仓库授权，不把未来 baseBranch 当成当前腿', async () => {
    const created = await service.create({
      scope: '普通实现任务',
      status: 'unassigned',
      metadata: { workspaceRoot: '/repo/studio', worktreeBaseBranch: 'main' },
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });

    expect(created.mandate?.repositories).toEqual([{ repo: '/repo/studio', leg: null }]);
    await expect(service.claim(created.id, 'agent-1')).resolves.toMatchObject({ status: 'active' });
  });

  it('派生 WU 继承原请求人与范围，显式越仓会被拒绝', async () => {
    const parent = await service.create({
      scope: '父任务',
      status: 'unassigned',
      reqId: 'REQ-0002',
      metadata: { workspaceRoot: '/repo/api', tokenBudget: 10_000 },
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });

    const child = await service.create({ scope: '子任务', parentId: parent.id, status: 'unassigned' });

    expect(child.mandate).toMatchObject({
      requestedBy: operator,
      source: { kind: 'derived', parentWorkUnitId: parent.id },
      reqId: 'REQ-0002',
      repositories: [{ repo: '/repo/api', leg: null }],
      budget: { tokens: 10_000, planSteps: null },
    });
    await expect(service.create({
      scope: '越仓子任务',
      parentId: parent.id,
      metadata: { workspaceRoot: '/repo/web' },
    })).rejects.toThrow('Mandate scope exceeded');
  });

  it('旧父单缺少可靠 Mandate 时，派生必须重新授权而不是获得 System 全权限', async () => {
    const legacy = await service.create({ scope: '旧父单', status: 'unassigned' });
    const snapshot = (await store.getIndex({ id: legacy.id }))[0]!;
    const { mandate: _mandate, ...withoutMandate } = snapshot;
    await store.commitSnapshot({
      type: 'updated', wuId: legacy.id, timestamp: new Date().toISOString(),
      data: withoutMandate as unknown as Record<string, unknown>,
    }, withoutMandate);

    await expect(service.create({ scope: '旧单派生', parentId: legacy.id }))
      .rejects.toThrow('Mandate authorization required');
  });

  it('只有获授权主体可以扩仓和追加预算，并留下操作人历史', async () => {
    const created = await service.create({
      scope: '授权扩仓',
      status: 'unassigned',
      metadata: { workspaceRoot: '/repo/api', tokenBudget: 10_000 },
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });

    await expect(service.authorizeMandate(created.id,
      { id: 'agent-1', type: 'System' },
      { repositories: [{ repo: '/repo/web', leg: null }] },
    )).rejects.toThrow('Mandate expansion forbidden');

    const expanded = await service.authorizeMandate(created.id, operator, {
      repositories: [{ repo: '/repo/web', leg: 'pmo/web' }],
      budget: { tokens: 20_000 },
    });

    expect(expanded.mandate).toMatchObject({
      revision: 2,
      grantedBy: operator,
      repositories: [{ repo: '/repo/web', leg: 'pmo/web' }],
      budget: { tokens: 20_000, planSteps: null },
    });
    expect(expanded.mandate?.history.at(-1)).toMatchObject({ action: 'expanded', actor: operator, revision: 2 });
    expect(JSON.parse(expanded.metadata ?? '{}')).toMatchObject({
      workspaceRoot: '/repo/web', pmoBranch: 'pmo/web', tokenBudget: 20_000,
    });
  });

  it('撤销阻止新执行并取消未决轮次，重新授权后才可恢复', async () => {
    const created = await service.create({
      scope: '可撤销任务', status: 'unassigned',
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });
    await service.claim(created.id, 'instance-1');
    await service.unclaim(created.id);

    const revoked = await service.revokeMandate(created.id, operator, '停止交付');

    expect(revoked.mandate).toMatchObject({
      revokedBy: operator,
      revokeReason: '停止交付',
    });
    expect(revoked.execution?.assignments.every(a => !['queued', 'running', 'waiting'].includes(a.status))).toBe(true);
    await expect(service.claim(created.id, 'instance-2')).rejects.toThrow('Mandate revoked');

    await service.authorizeMandate(created.id, operator, { reason: '恢复执行' });
    const recovered = await service.claim(created.id, 'instance-2');
    expect(recovered.execution?.current).toMatchObject({ status: 'queued', reason: 'retry' });
    expect(recovered.mandate?.revokedAt).toBeUndefined();
    expect(recovered.mandate?.history.at(-1)).toMatchObject({ action: 'reauthorized', actor: operator });
  });

  it('#707: 撤销取消排队评审，运行中副作用进入恢复核查', async () => {
    const queued = await service.create({
      scope: '排队评审', status: 'active', channelId: 'channel-1',
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });
    await service.transitionStatus(queued.id, 'in_review');
    const revokedQueued = await service.revokeMandate(queued.id, operator, '停止评审');
    const queuedSnapshot = (await store.getIndex({ id: revokedQueued.id }))[0]!;
    expect(queuedSnapshot.effects?.[0]).toMatchObject({ status: 'cancelled' });
    expect(queuedSnapshot.effectReceipts?.at(-1)).toMatchObject({
      outcome: 'cancelled', recovery: 'revocation',
    });

    const running = await service.create({
      scope: '运行中评审', status: 'active', channelId: 'channel-1',
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });
    await service.transitionStatus(running.id, 'in_review');
    const current = (await store.getIndex({ id: running.id }))[0]!;
    const runningSnapshot: typeof current = {
      ...current,
      effects: current.effects?.map(effect => ({ ...effect, status: 'running' as const, attempts: 1 })),
    };
    await store.commitSnapshot({
      type: 'updated', wuId: running.id, timestamp: new Date().toISOString(),
      data: runningSnapshot as unknown as Record<string, unknown>,
    }, runningSnapshot);

    await service.revokeMandate(running.id, operator, '核查运行中副作用');
    const revokedRunning = (await store.getIndex({ id: running.id }))[0]!;
    expect(revokedRunning.effects?.[0]).toMatchObject({ status: 'needs_reconciliation' });
  });

  it('恢复认领时发现执行根已漂出 Mandate，会拒绝而不是继续执行', async () => {
    const created = await service.create({
      scope: '范围重验', status: 'unassigned',
      metadata: { workspaceRoot: '/repo/api', pmoBranch: 'pmo/api' },
      authorization: { requestedBy: operator, source: { kind: 'api' } },
    });
    await service.update(created.id, { metadata: { workspaceRoot: '/repo/other', pmoBranch: 'pmo/other' } });

    await expect(service.claim(created.id, 'instance-1')).rejects.toThrow('Mandate scope exceeded');
    expect((await service.getById(created.id))?.execution).toBeUndefined();
  });
});
