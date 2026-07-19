/**
 * REQ 绑定测试（vision §5.3）— @mention 派发 / convert-to-task
 *
 * 覆盖：
 * - @mention 派发自动创建需求（REQ-XXXX，in-progress，channelId 落档，标题取消息）
 * - #REQ-XXXX token 解析（大小写不敏感）+ 存在性校验
 * - 绑定优先级：显式 reqId > #REQ-XXXX token > 自动新建
 * - best-effort：需求创建失败不阻断 WorkUnit 创建（log + 不带 reqId 继续）
 * - convert-to-task 同样绑定（token / 自动新建）
 * - parseReqToken / normalizeReqId 纯函数
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../../channels/message-routing.js';
import { channelMessageService } from '../../channels/channel-message.service.js';
import { ConvertToTaskService } from '../../channels/convert-to-task.service.js';
import { RequirementService } from '../requirement.service.js';
import { parseReqToken, normalizeReqId, resolveReqIdForDispatch } from '../req-binding.js';

let tmpDir: string;
let fileStore: FileStore;
let reqService: RequirementService;
const channelId = 'req-binding-ch';

async function findWuByMessage(workUnitId: string | null | undefined) {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === workUnitId) ?? null;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-binding-test-'));
  fileStore = new FileStore(tmpDir);
  reqService = new RequirementService(fileStore);
  await fileStore.createChannel({
    id: channelId, name: '#req-binding', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  channelMessageService.setFileStore(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseReqToken / normalizeReqId', () => {
  it('parses #REQ-XXXX token case-insensitively and normalizes padding', () => {
    expect(parseReqToken('做这个 #REQ-0042 谢谢')).toBe('REQ-0042');
    expect(parseReqToken('做这个 #req-7')).toBe('REQ-0007');
    expect(parseReqToken('#Req-123')).toBe('REQ-0123');
    expect(parseReqToken('没有 token')).toBeNull();
    expect(parseReqToken('#REQUEST-1 不算')).toBeNull();
  });

  it('normalizeReqId accepts REQ-42 / req-0042, rejects garbage', () => {
    expect(normalizeReqId('REQ-42')).toBe('REQ-0042');
    expect(normalizeReqId('req-0042')).toBe('REQ-0042');
    expect(normalizeReqId(' REQ-9 ')).toBe('REQ-0009');
    expect(normalizeReqId('REQ-0')).toBeNull();
    expect(normalizeReqId('hello')).toBeNull();
  });
});

describe('@mention 派发 → REQ 自动绑定（vision §5.3）', () => {
  it('auto-creates a requirement on first @mention dispatch', async () => {
    const result = await routeMessage(channelId, '@Agent 实现登录功能', undefined, fileStore);

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu).not.toBeNull();
    expect(wu!.reqId).toBe('REQ-0001');

    const req = await reqService.get('REQ-0001');
    expect(req).not.toBeNull();
    expect(req!.status).toBe('in-progress');
    expect(req!.channelId).toBe(channelId);
    expect(req!.createdBy).toBe('mention');
    expect(req!.title).toContain('实现登录功能');
  });

  it('auto-creates a NEW requirement per dispatch (REQ-0002, REQ-0003, ...)', async () => {
    const r1 = await routeMessage(channelId, '@Agent 任务一', undefined, fileStore);
    const r2 = await routeMessage(channelId, '@Agent 任务二', undefined, fileStore);

    expect((await findWuByMessage(r1.workUnitId))!.reqId).toBe('REQ-0001');
    expect((await findWuByMessage(r2.workUnitId))!.reqId).toBe('REQ-0002');
    expect((await reqService.list()).length).toBe(2);
  });

  it('binds to existing requirement via #REQ-XXXX token (no new requirement)', async () => {
    const existing = await reqService.create({ title: '已有需求', channelId });

    const result = await routeMessage(channelId, `@Agent 继续 #${existing.id} 的剩余工作`, undefined, fileStore);

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu!.reqId).toBe(existing.id);
    expect((await reqService.list()).length).toBe(1); // 未新建
  });

  it('token for non-existent REQ falls through to auto-create', async () => {
    const result = await routeMessage(channelId, '@Agent 做 #REQ-0999 的事', undefined, fileStore);

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu!.reqId).toBe('REQ-0001'); // 新建的，不是 REQ-0999
    expect(await reqService.get('REQ-0999')).toBeNull();
  });

  it('explicit reqId wins over #REQ-XXXX token', async () => {
    const explicit = await reqService.create({ title: '显式需求', channelId });
    const token = await reqService.create({ title: 'token 需求', channelId });

    const result = await routeMessage(
      channelId,
      `@Agent 做 #REQ-${String(token.seq).padStart(4, '0')} 的事`,
      undefined,
      fileStore,
      { reqId: explicit.id },
    );

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu!.reqId).toBe(explicit.id);
  });

  it('explicit reqId that does not exist falls through to token / auto-create', async () => {
    const result = await routeMessage(channelId, '@Agent 任务', undefined, fileStore, { reqId: 'REQ-0999' });

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu!.reqId).toBe('REQ-0001'); // 自动新建
  });

  it('best-effort: requirement creation failure does not break WorkUnit creation', async () => {
    // 制造存储层故障：requirements 路径被同名文件占用 → mkdir lock 失败
    fs.writeFileSync(path.join(tmpDir, 'requirements'), 'block-dir', 'utf-8');

    const result = await routeMessage(channelId, '@Agent 容错任务', undefined, fileStore);

    const wu = await findWuByMessage(result.workUnitId);
    expect(wu).not.toBeNull();          // WorkUnit 照常创建
    expect(wu!.reqId ?? null).toBeNull(); // 仅无 reqId
    expect(result.workUnitId).toBe(wu!.id);
  });

  it('reply (replyToId) path does NOT create requirements', async () => {
    const first = await routeMessage(channelId, '@Agent 主任务', undefined, fileStore);
    const before = (await reqService.list()).length;

    await routeMessage(channelId, '跟进一下', first.id, fileStore);

    expect((await reqService.list()).length).toBe(before);
  });
});

describe('convert-to-task → REQ 绑定（vision §5.3）', () => {
  async function createSourceMessage(content: string): Promise<string> {
    const msg = await channelMessageService.createHumanMessage(channelId, content);
    return msg.id;
  }

  it('auto-creates a requirement when converting a plain message', async () => {
    const msgId = await createSourceMessage('把这句话转成任务');
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, {});

    expect(wu.reqId).toBe('REQ-0001');
    const req = await reqService.get('REQ-0001');
    expect(req!.createdBy).toBe('convert');
    expect(req!.status).toBe('in-progress');
    expect(req!.channelId).toBe(channelId);
  });

  it('binds existing requirement via token in source message', async () => {
    const existing = await reqService.create({ title: '转换目标需求', channelId });
    const msgId = await createSourceMessage(`这个属于 #req-${existing.seq}`);
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, {});

    expect(wu.reqId).toBe(existing.id);
    expect((await reqService.list()).length).toBe(1);
  });

  it('explicit reqId wins over token', async () => {
    const token = await reqService.create({ title: 'token 需求', channelId });
    const explicit = await reqService.create({ title: '显式需求', channelId });
    const msgId = await createSourceMessage(`这个属于 #REQ-${String(token.seq).padStart(4, '0')}`);
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, { reqId: explicit.id });

    expect(wu.reqId).toBe(explicit.id);
  });

  it('best-effort: requirement failure does not break conversion', async () => {
    const msgId = await createSourceMessage('容错转换');
    fs.writeFileSync(path.join(tmpDir, 'requirements'), 'block-dir', 'utf-8');
    const service = new ConvertToTaskService(fileStore);

    const wu = await service.convert(channelId, msgId, {});

    expect(wu).toBeTruthy();
    expect(wu.reqId ?? null).toBeNull();
  });
});

describe('resolveReqIdForDispatch', () => {
  it('returns null-safe ids per precedence', async () => {
    const existing = await reqService.create({ title: '目标', channelId });

    // 显式优先
    expect(await resolveReqIdForDispatch({
      explicitReqId: existing.id, content: '任意', channelId, createdBy: 'mention', fileStore,
    })).toBe(existing.id);

    // token 次之
    expect(await resolveReqIdForDispatch({
      content: `做 #req-${existing.seq}`, channelId, createdBy: 'mention', fileStore,
    })).toBe(existing.id);

    // 否则自动新建
    const autoId = await resolveReqIdForDispatch({
      content: '全新任务', channelId, createdBy: 'mention', fileStore,
    });
    expect(autoId).toMatch(/^REQ-\d{4}$/);
    expect(autoId).not.toBe(existing.id);
  });
});
