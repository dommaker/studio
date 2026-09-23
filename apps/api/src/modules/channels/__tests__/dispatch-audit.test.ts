/**
 * #591 B 类：@mention 派单 / 合并窗口的 dispatch 决策埋点
 * （落 audit-logs 轨；依据 = 匹配方式摘要；requestId = ctx.traceId 频道链路口径）。
 * #632：决策12 默认角色（via=default-role）随 defaultProfileId 退役删除；
 * 新增 intent=new-task 显式建单埋点（via=new-task）。
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

async function createChannelWith(): Promise<string> {
  const id = `ch-dispatch-${Date.now()}-${++channelSeq}`;
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
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
    const channelId = await createChannelWith();
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
    const channelId = await createChannelWith();

    await routeMessage(channelId, '@Nobody 帮忙', undefined, { fs: fileStore });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      actor: undefined,
      details: expect.objectContaining({ via: 'mention', mentionName: 'Nobody', matched: false }),
    }));
  });

  it('intent=new-task 显式建单 → dispatch 行（via=new-task，未指派无 actor）', async () => {
    const channelId = await createChannelWith();

    const msg = await routeMessage(channelId, '帮我看个报错', undefined, { fs: fileStore, traceId: 'trace-d2', intent: 'new-task' });

    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      resourceId: msg.workUnitId,
      requestId: 'trace-d2',
      details: expect.objectContaining({ via: 'new-task', channelId }),
    }));
  });

  it('合并窗口并入在途 WU → dispatch 行（via=merge，对象=在途 WU），不新建第二张单', async () => {
    const channelId = await createChannelWith();

    // #632：合并窗口已解耦——先造在途 WU + 窗口内携带它的人类消息作为合并锚点
    const wu = await workUnitService.create({
      scope: '在途任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
    });
    await fileStore.appendMessage(channelId, {
      id: `m-${channelId}`, channelId, authorType: 'human', agentName: null,
      content: '第一条', replyToId: null, meta: '{}', workUnitId: wu.id,
      createdAt: new Date().toISOString(),
    });
    decisionSpy.mockClear();
    await routeMessage(channelId, '第二条（窗口内）', undefined, { fs: fileStore });

    expect(decisionSpy).toHaveBeenCalledTimes(1);
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch',
      resourceId: wu.id,
      details: expect.objectContaining({ via: 'merge' }),
    }));
  });

  it('线程回复 / 无地址纯文本（无合并目标）→ 不落 dispatch 行', async () => {
    const channelId = await createChannelWith();
    const first = await routeMessage(channelId, '@Nobody 建个单', undefined, { fs: fileStore });
    decisionSpy.mockClear();

    await routeMessage(channelId, '线程里的回复', first.id, { fs: fileStore });
    expect(decisionSpy).not.toHaveBeenCalled();

    // #632：无地址纯文本在无合并目标的频道 → 纯存储不落埋点
    const emptyChannel = await createChannelWith();
    await routeMessage(emptyChannel, '无 @ 纯文本', undefined, { fs: fileStore });
    expect(decisionSpy).not.toHaveBeenCalled();
  });
});
