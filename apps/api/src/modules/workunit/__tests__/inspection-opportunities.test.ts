/**
 * #163（T8-E2，#130 决策 6）：巡检机会采纳/忽略服务测试——
 * 采纳 → feature 子单显式 unassigned（T4 单层人闸）+ 条目记 wuId；忽略 → 终态可附理由。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type InspectionOpportunity } from '../workunit.service';
import { parseWuMetadata } from '../wu-metadata';
import { adoptInspectionOpportunity, ignoreInspectionOpportunity } from '../inspection-opportunities';

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;

const OPPS: InspectionOpportunity[] = [
  { id: 'opp-1', problem: '登录接口缺少限流', suggestion: '加 rate-limit 中间件', estimate: '半天', status: 'pending' },
  { id: 'opp-2', problem: 'README 与启动命令不一致', suggestion: '改快速开始段', status: 'pending' },
];

async function seedInspectionWu(metadata?: Record<string, unknown>) {
  return service.create({
    type: 'analysis',
    scope: '全仓巡检',
    status: 'in_review',
    metadata: {
      inspection: true,
      opportunities: OPPS,
      pmoId: 'pmo-1',
      workspaceRoot: '/repo/x',
      ...metadata,
    },
  });
}

const readOpps = async (wuId: string): Promise<InspectionOpportunity[]> => {
  const wu = await service.getById(wuId);
  return parseWuMetadata(wu!.metadata).opportunities!;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspection-opps-test-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('adoptInspectionOpportunity', () => {
  it('采纳 → 建 feature 子单显式 unassigned（不落 pending），条目记 wuId', async () => {
    const source = await seedInspectionWu();

    const { workUnit, opportunities } = await adoptInspectionOpportunity(service, source.id, 'opp-1');

    // 子单：feature + 显式 unassigned 进 frontier（单层人闸：采纳动作即人工闸）
    expect(workUnit.type).toBe('feature');
    expect(workUnit.status).toBe('unassigned');
    expect(workUnit.parentId).toBe(source.id);
    expect(workUnit.scope).toContain('登录接口缺少限流');
    expect(workUnit.scope).toContain('加 rate-limit 中间件');
    expect(workUnit.scope).toContain('半天');
    // 不带 channelId（避免触发频道默认管线展开）
    expect(workUnit.channelId).toBeNull();
    // 溯源 + 归属链继承
    const childMeta = parseWuMetadata(workUnit.metadata);
    expect(childMeta.creationMode).toBe('inspection-adopt');
    expect(childMeta.sourceInspectionWuId).toBe(source.id);
    expect(childMeta.sourceOpportunityId).toBe('opp-1');
    expect(childMeta.pmoId).toBe('pmo-1');
    expect(childMeta.workspaceRoot).toBe('/repo/x');

    // 源条目：已开单 + 记 wuId；其余条目不动
    expect(opportunities[0]).toMatchObject({ status: 'adopted', wuId: workUnit.id });
    expect(opportunities[1]).toMatchObject({ status: 'pending' });
    // 落库一致
    expect(await readOpps(source.id)).toEqual(opportunities);
  });

  it('重复采纳同一条目 → 拒绝（already resolved）', async () => {
    const source = await seedInspectionWu();
    await adoptInspectionOpportunity(service, source.id, 'opp-1');
    await expect(adoptInspectionOpportunity(service, source.id, 'opp-1'))
      .rejects.toThrow('already resolved');
    // 不重复开单
    const list = await service.list({ type: 'feature' });
    expect(list.data).toHaveLength(1);
  });

  it('非巡检单 / 条目不存在 → 报错', async () => {
    const plain = await service.create({ type: 'analysis', scope: '普通分析' });
    await expect(adoptInspectionOpportunity(service, plain.id, 'opp-1'))
      .rejects.toThrow('not an inspection');
    const source = await seedInspectionWu();
    await expect(adoptInspectionOpportunity(service, source.id, 'opp-99'))
      .rejects.toThrow('not found');
    await expect(adoptInspectionOpportunity(service, 'wu-nope', 'opp-1'))
      .rejects.toThrow('not found');
  });
});

describe('ignoreInspectionOpportunity', () => {
  it('忽略 → 终态 + 可附理由', async () => {
    const source = await seedInspectionWu();

    const { opportunities } = await ignoreInspectionOpportunity(service, source.id, 'opp-2', '与下个迭代冲突，暂缓');

    expect(opportunities[1]).toMatchObject({
      status: 'ignored',
      ignoreReason: '与下个迭代冲突，暂缓',
    });
    expect(opportunities[0]).toMatchObject({ status: 'pending' });
    // 不开单
    expect((await service.list({ type: 'feature' })).data).toHaveLength(0);
    // 落库一致
    expect(await readOpps(source.id)).toEqual(opportunities);
  });

  it('忽略可不带理由；终态后不可再采纳/再忽略', async () => {
    const source = await seedInspectionWu();

    const { opportunities } = await ignoreInspectionOpportunity(service, source.id, 'opp-1');
    expect(opportunities[0].status).toBe('ignored');
    expect(opportunities[0].ignoreReason).toBeUndefined();

    await expect(ignoreInspectionOpportunity(service, source.id, 'opp-1'))
      .rejects.toThrow('already resolved');
    await expect(adoptInspectionOpportunity(service, source.id, 'opp-1'))
      .rejects.toThrow('already resolved');
  });

  it('忽略不影响其它 metadata 字段（read-modify-write 不丢字段）', async () => {
    const source = await seedInspectionWu({ tokenBudget: 500000 });
    await ignoreInspectionOpportunity(service, source.id, 'opp-1', 'r');
    const meta = parseWuMetadata((await service.getById(source.id))!.metadata);
    expect(meta.inspection).toBe(true);
    expect(meta.tokenBudget).toBe(500000);
    expect(meta.pmoId).toBe('pmo-1');
  });
});
