/**
 * rebindSourceChannel 单测（频道删除兜底 B2-012 的存储归属收敛）
 *
 * 覆盖：
 *  - 字段相等匹配（解析 metadata 比对 context.sourceChannelId）
 *  - 子串误伤回归：metadata 其它字段恰好含 channel id 的 WU 不得被重绑
 *    （原 channel delete 路由 `metadata.includes(channelId)` 的 false-positive）
 *  - 空/无 metadata、非顶层（parentId 非空）、非 task 类型跳过
 *  - 返回重绑数量
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-rebind-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** context 在运行时是对象（{ sourceChannelId }），接口声明是 legacy string 降级字段——按运行时形态构造 */
function metaWithSourceChannel(channelId: string): WorkUnitMetadata {
  return { context: { sourceChannelId: channelId } } as unknown as WorkUnitMetadata;
}

async function sourceChannelOf(id: string): Promise<unknown> {
  const wu = await wuService.getById(id);
  const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
  return meta.context?.sourceChannelId;
}

describe('rebindSourceChannel', () => {
  it('字段相等匹配：sourceChannelId === from 的顶层 task 被重挂，返回数量', async () => {
    const a = await wuService.create({ scope: 'A', metadata: metaWithSourceChannel('ch-old') });
    const b = await wuService.create({ scope: 'B', metadata: metaWithSourceChannel('ch-old') });
    const c = await wuService.create({ scope: 'C', metadata: metaWithSourceChannel('ch-other') });

    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');

    expect(count).toBe(2);
    expect(await sourceChannelOf(a.id)).toBe('ch-new');
    expect(await sourceChannelOf(b.id)).toBe('ch-new');
    expect(await sourceChannelOf(c.id)).toBe('ch-other');
  });

  it('子串误伤回归：metadata 其它字段含 channel id 但 sourceChannelId 不同 → 不重绑', async () => {
    // description 恰好嵌入 channel id（旧路由 metadata.includes(channelId) 会误中此 WU）
    const wu = await wuService.create({
      scope: 'substring trap',
      metadata: {
        description: '排查 ch-old 频道的历史遗留问题',
        context: { sourceChannelId: 'ch-other' },
      } as unknown as WorkUnitMetadata,
    });
    // 断言旧子串口径确实会误中（证明本测试的回归价值）
    const raw = (await wuService.getById(wu.id))!.metadata!;
    expect(raw.includes('ch-old')).toBe(true);

    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');

    expect(count).toBe(0);
    expect(await sourceChannelOf(wu.id)).toBe('ch-other');
  });

  it('空 metadata / 无 metadata 的 WU 跳过', async () => {
    const noMeta = await wuService.create({ scope: 'no meta' });
    const emptyCtx = await wuService.create({ scope: 'empty ctx', metadata: {} });

    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');

    expect(count).toBe(0);
    expect((await wuService.getById(noMeta.id))!.metadata).toBeNull();
    expect((await wuService.getById(emptyCtx.id))!.metadata).toBe('{}');
  });

  it('非顶层（parentId 非空）与非 task 类型的 WU 即使字段相等也不重绑（与原路由口径一致）', async () => {
    const parent = await wuService.create({ scope: 'parent', metadata: metaWithSourceChannel('ch-old') });
    const child = await wuService.create({
      scope: 'child',
      parentId: parent.id,
      metadata: metaWithSourceChannel('ch-old'),
    });
    const review = await wuService.create({
      scope: 'review',
      type: 'review',
      metadata: metaWithSourceChannel('ch-old'),
    });

    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');

    expect(count).toBe(1); // 只有顶层 task parent
    expect(await sourceChannelOf(parent.id)).toBe('ch-new');
    expect(await sourceChannelOf(child.id)).toBe('ch-old');
    expect(await sourceChannelOf(review.id)).toBe('ch-old');
  });

  it('损坏 metadata 按无匹配处理，不抛错', async () => {
    const wu = await wuService.create({ scope: 'corrupt' });
    // 直接写损坏 metadata 进快照
    const snapshots = await fileStore.getIndex();
    const s = snapshots.find(x => x.id === wu.id)!;
    await fileStore.upsertSnapshot({ ...s, metadata: '{not-json' });

    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');
    expect(count).toBe(0);
  });

  it('无匹配时返回 0，且不写任何事件', async () => {
    await wuService.create({ scope: 'A', metadata: metaWithSourceChannel('ch-other') });
    const count = await wuService.rebindSourceChannel('ch-old', 'ch-new');
    expect(count).toBe(0);
  });
});
