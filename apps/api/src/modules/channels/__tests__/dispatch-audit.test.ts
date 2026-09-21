/**
 * #591 B 类：@mention 派单 / 决策12 默认角色 / 合并窗口的 dispatch 决策埋点
 * （落 audit-logs 轨；依据 = 匹配方式摘要；requestId = ctx.traceId 频道链路口径）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

const { decisionSpy } = vi.hoisted(() => ({ decisionSpy: vi.fn() }));
vi.mock('../../audit-logs/agent-decision.js', () => ({ recordAgentDecision: decisionSpy }));

let tmpDir: string;
let fileStore: FileStore;
let workUnitService: WorkUnitService;
let channelSeq = 0;

async function createChannelWith(defaultProfileId: string | null): Promise<string> {
  const id = `ch-dispatch-${Date.now()}-${++channelSeq}`;
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
    defaultProfileId,
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return id;
}

async function createProfile(id: string, name: string) {
  await fileStore.createProfile({
    id, name, description: 'test', channels: '[]', status: 'active',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
}

describe('dispatch 决策埋点（#591）', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-audit-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    channelMessageService.setFileStore(fileStore);
  });

  it('@mention 精确命中 → dispatch 行（actor=被指名 profile，via=mention，traceId 透传）', async () => {
    const channelId = await createChannelWith(null);
    await createProfile('prof-dev', 'Dev');

    const msg = await routeMessage(channelId, '@Dev 看下这个', undefined, { fs: fileStore, traceId: 'trace-d1' });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      resource: 'workunit',
      resourceId: msg.workUnitId,
      actor: { id: 'prof-dev', type: 'agent' },
      requestId: 'trace-d1',
      details: expect.objectContaining({ via: 'mention', mentionName: 'Dev', matched: true, channelId }),
    }));
  });

  it('@mention 未匹配（转自动认领）→ dispatch 行 matched:false、无 actor', async () => {
    const channelId = await createChannelWith(null);

    await routeMessage(channelId, '@Nobody 帮忙', undefined, { fs: fileStore });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      actor: undefined,
      details: expect.objectContaining({ via: 'mention', mentionName: 'Nobody', matched: false }),
    }));
  });

  it('决策12 默认角色建单 → dispatch 行（via=default-role，actor=defaultProfileId）', async () => {
    const channelId = await createChannelWith('prof-default');

    const msg = await routeMessage(channelId, '帮我看个报错', undefined, { fs: fileStore, traceId: 'trace-d2' });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      resourceId: msg.workUnitId,
      actor: { id: 'prof-default', type: 'agent' },
      requestId: 'trace-d2',
      details: expect.objectContaining({ via: 'default-role', channelId }),
    }));
  });

  it('合并窗口并入在途 WU → dispatch 行（via=merge，对象=在途 WU），不新建第二张单', async () => {
    const channelId = await createChannelWith('prof-default');

    const first = await routeMessage(channelId, '第一条', undefined, { fs: fileStore });
    decisionSpy.mockClear();
    await routeMessage(channelId, '第二条（窗口内）', undefined, { fs: fileStore });

    expect(decisionSpy).toHaveBeenCalledTimes(1);
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      resourceId: first.workUnitId,
      details: expect.objectContaining({ via: 'merge' }),
    }));
  });

  it('线程回复 / 无默认角色纯文本 → 不落 dispatch 行', async () => {
    const channelId = await createChannelWith(null);
    const first = await routeMessage(channelId, '@Nobody 建个单', undefined, { fs: fileStore });
    decisionSpy.mockClear();

    await routeMessage(channelId, '线程里的回复', first.id, { fs: fileStore });
    await routeMessage(channelId, '无 @ 纯文本', undefined, { fs: fileStore });

    expect(decisionSpy).not.toHaveBeenCalled();
  });
});
