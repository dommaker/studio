// #428（#402 决策 4 补交）：WU 列表「未归属」服务端过滤/计数。
// 未归属口径（#402 决策 1 逐 WU 解析 + #405 AC）：无 reqId 且 pmoId 归因戳
// （canonical metadata.pmoId ‖ legacy ownershipProjectId，parseWuPmoId 解析）为 null。
// 计数能力复用分页响应 total（过滤后计数），不单开 count 端点。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('WorkUnitService.list attributed 过滤（#428）', () => {
  let tmpDir: string;
  let service: WorkUnitService;

  // 夹具：A/B 未归属；C 有 reqId；D 有 canonical 戳；E 有 legacy 戳
  let orphanPendingId: string;
  let orphanDoneId: string;
  let withReqId: string;
  let withPmoStampId: string;
  let withLegacyStampId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-unattr-test-'));
    service = new WorkUnitService(new FileStore(tmpDir));

    orphanPendingId = (await service.create({ scope: 'orphan pending' })).id;
    orphanDoneId = (await service.create({ scope: 'orphan done', status: 'done' })).id;
    withReqId = (await service.create({ scope: 'with req', reqId: 'REQ-428-A' })).id;
    withPmoStampId = (await service.create({ scope: 'with pmo stamp', metadata: { pmoId: 'PMO-1' } })).id;
    withLegacyStampId = (await service.create({
      scope: 'with legacy stamp',
      metadata: { ownershipProjectId: 'PMO-9' },
    })).id;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('attributed=false 只返回无 reqId 且无归因戳的 WU', async () => {
    const result = await service.list({ attributed: false });
    const ids = result.data.map(w => w.id);

    expect(ids).toContain(orphanPendingId);
    expect(ids).toContain(orphanDoneId);
    expect(ids).not.toContain(withReqId);
    expect(ids).not.toContain(withPmoStampId);
    expect(ids).not.toContain(withLegacyStampId); // legacy 同位名戳视为已归属
  });

  it('total 是过滤后全量计数，非当前页数量', async () => {
    const result = await service.list({ attributed: false, page: 1, limit: 1 });

    expect(result.data.length).toBe(1);
    expect(result.total).toBe(2);
  });

  it('attributed=true 反向过滤：有 reqId 或归因戳非 null', async () => {
    const result = await service.list({ attributed: true });
    const ids = result.data.map(w => w.id);

    expect(ids).toContain(withReqId);
    expect(ids).toContain(withPmoStampId);
    expect(ids).toContain(withLegacyStampId);
    expect(ids).not.toContain(orphanPendingId);
    expect(ids).not.toContain(orphanDoneId);
  });

  it('不传 attributed 时行为不变（全量，不过滤）', async () => {
    const result = await service.list({});
    const ids = result.data.map(w => w.id);

    for (const id of [orphanPendingId, orphanDoneId, withReqId, withPmoStampId, withLegacyStampId]) {
      expect(ids).toContain(id);
    }
  });

  it('与既有 status 过滤可组合（交集语义）', async () => {
    const result = await service.list({ attributed: false, status: 'done' });
    const ids = result.data.map(w => w.id);

    expect(ids).toContain(orphanDoneId);
    expect(ids).not.toContain(orphanPendingId);
    expect(result.total).toBe(1);
  });
});
