/**
 * #281（决策 #249 §2/§3 + #257 D7/D9）：路由层 @文件引用校验。
 *
 * - 发送含文件引用的消息 → 校验通过的写结构化 meta.files=[{repo, path}]；
 * - 失效引用剔除（不进消息 meta、不进 WU）+ 频道系统播报（Studio 系统消息）
 *   + 新事件 channel:file_refs_dropped（reason=not-found/not-in-candidate-set，
 *   dropped 封顶前 5 条 + droppedCount 全量计数）。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { readStudioEvents, parseStudioEventPayload } from '../../../utils/studio-events.js';
import {
  invalidateFileRefVocabularyCache,
  type FileRefVocabularyDeps,
} from '../file-ref-vocabulary.js';

let tmpDir: string;
let eventsFile: string;
let fileStore: FileStore;
const channelId = `test-fileref-routing-${Date.now()}`;

const now = () => new Date().toISOString();

function makeDeps(): FileRefVocabularyDeps {
  return {
    fileStore,
    resolveWorkspaceRoot: async id => (id === 'ws-1' ? '/repo/default' : null),
    getProject: async () => null,
    findChoreProject: async () => null,
    listFiles: async () => ['src/a.ts', 'src/b.ts', 'README.md'],
  };
}

function parseMeta(meta: unknown): Record<string, unknown> {
  return typeof meta === 'string' ? JSON.parse(meta) : (meta as Record<string, unknown>);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileref-routing-test-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = eventsFile;
});

afterAll(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fileStore = new FileStore(tmpDir);
  await fileStore.createChannel({
    id: channelId, name: '#test-fileref-routing', type: 'rnd',
    defaultWorkspaceId: 'ws-1', defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now(), updatedAt: now(),
  });
  channelMessageService.setFileStore(fileStore);
  invalidateFileRefVocabularyCache();
});

describe('路由层文件引用校验（#281）', () => {
  it('全部有效 → meta.files 全量写入消息，无播报无事件', async () => {
    const files = [
      { repo: '/repo/default', path: 'src/a.ts' },
      { repo: '/repo/default', path: 'README.md' },
    ];
    const message = await routeMessage(channelId, '看这两个文件', undefined, fileStore, {
      files, fileRefDeps: makeDeps(),
    });

    expect(parseMeta(message.meta).files).toEqual(files);
    const all = await fileStore.queryMessages(channelId);
    expect(all.filter(m => m.authorType === 'agent')).toHaveLength(0);
    expect(await readStudioEvents({ file: eventsFile })).toHaveLength(0);
  });

  it('失效引用剔除：不进 meta.files，频道收到 Studio 播报，落 file_refs_dropped 事件', async () => {
    const message = await routeMessage(channelId, '看文件', undefined, fileStore, {
      files: [
        { repo: '/repo/default', path: 'src/a.ts' },
        { repo: '/repo/default', path: 'src/gone.ts' },
        { repo: '/repo/other', path: 'src/a.ts' },
      ],
      fileRefDeps: makeDeps(),
    });

    // 剔除的不进消息 meta（有效引用原样保留）
    expect(parseMeta(message.meta).files).toEqual([{ repo: '/repo/default', path: 'src/a.ts' }]);

    // 频道系统播报（Studio 系统消息，挂在原消息线程）
    const all = await fileStore.queryMessages(channelId);
    const broadcast = all.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(broadcast).toBeTruthy();
    expect(broadcast!.content).toContain('src/gone.ts');
    expect(broadcast!.content).toContain('src/a.ts');
    expect(broadcast!.replyToId).toBe(message.id);

    // 事件：reason + paths（每条引用带 reason）
    const events = await readStudioEvents({ file: eventsFile });
    const dropped = events.filter(e => e.type === 'channel:file_refs_dropped');
    expect(dropped).toHaveLength(1);
    const payload = parseStudioEventPayload<{
      channelId: string; messageId: string; droppedCount: number;
      dropped: { repo: string; path: string; reason: string }[];
    }>(dropped[0])!;
    expect(payload.channelId).toBe(channelId);
    expect(payload.messageId).toBe(message.id);
    expect(payload.droppedCount).toBe(2);
    expect(payload.dropped).toEqual([
      { repo: '/repo/default', path: 'src/gone.ts', reason: 'not-found' },
      { repo: '/repo/other', path: 'src/a.ts', reason: 'not-in-candidate-set' },
    ]);
  });

  it('校验自身故障（畸形引用触发异常）→ 不静默吞掉：系统播报 + file_refs_dropped 事件（reason=validation-failed）', async () => {
    // repo 非字符串 → validateFileRefs 内部抛 TypeError，走 catch 异常路径
    const message = await routeMessage(channelId, '看文件', undefined, fileStore, {
      files: [{ repo: null as unknown as string, path: 'src/a.ts' }],
      fileRefDeps: makeDeps(),
    });

    // 异常路径仍按无引用处理（meta.files 不写入），但可见性与正常剔除路径同等
    expect(parseMeta(message.meta).files).toBeUndefined();
    const all = await fileStore.queryMessages(channelId);
    const broadcast = all.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(broadcast).toBeTruthy();
    expect(broadcast!.content).toContain('校验失败');
    expect(broadcast!.replyToId).toBe(message.id);

    const events = await readStudioEvents({ file: eventsFile });
    const dropped = events.filter(e => e.type === 'channel:file_refs_dropped');
    expect(dropped).toHaveLength(1);
    const payload = parseStudioEventPayload<{
      droppedCount: number; dropped: { path: string; reason: string }[];
    }>(dropped[0])!;
    expect(payload.droppedCount).toBe(1);
    expect(payload.dropped).toEqual([{ repo: '', path: 'src/a.ts', reason: 'validation-failed' }]);
  });

  it('事件 payload 尺寸纪律：dropped 封顶前 5 条 + droppedCount 全量', async () => {
    const files = Array.from({ length: 7 }, (_, i) => ({ repo: '/repo/default', path: `gone-${i}.ts` }));
    await routeMessage(channelId, '看文件', undefined, fileStore, { files, fileRefDeps: makeDeps() });

    const events = await readStudioEvents({ file: eventsFile });
    const payload = parseStudioEventPayload<{ droppedCount: number; dropped: unknown[] }>(
      events.find(e => e.type === 'channel:file_refs_dropped')!,
    )!;
    expect(payload.droppedCount).toBe(7);
    expect(payload.dropped).toHaveLength(5);
  });

  it('@mention 建 WU 路径：剔除的引用不进 WU 线程消息 meta，有效引用保留', async () => {
    await fileStore.createProfile({
      id: 'agent-dev', name: 'dev', description: null, channels: '[]', status: 'active',
      createdAt: now(), updatedAt: now(),
    });
    const message = await routeMessage(channelId, '@dev 看文件', undefined, fileStore, {
      files: [
        { repo: '/repo/default', path: 'src/b.ts' },
        { repo: '/repo/default', path: 'nope.ts' },
      ],
      fileRefDeps: makeDeps(),
    });

    expect(message.workUnitId).toBeTruthy();
    expect(parseMeta(message.meta).files).toEqual([{ repo: '/repo/default', path: 'src/b.ts' }]);
    const events = await readStudioEvents({ file: eventsFile });
    expect(events.filter(e => e.type === 'channel:file_refs_dropped')).toHaveLength(1);
  });

  it('无文件引用 → 行为与现状一致（meta 为空对象）', async () => {
    const message = await routeMessage(channelId, 'plain', undefined, fileStore);
    expect(parseMeta(message.meta)).toEqual({});
  });

  it('线程回复路径：文件引用同样校验并写入回复消息 meta', async () => {
    const parent = await routeMessage(channelId, '父消息', undefined, fileStore);
    const reply = await routeMessage(channelId, '回复带文件', parent.id, fileStore, {
      files: [{ repo: '/repo/default', path: 'src/a.ts' }],
      fileRefDeps: makeDeps(),
    });
    expect(parseMeta(reply.meta).files).toEqual([{ repo: '/repo/default', path: 'src/a.ts' }]);
  });
});

/** 读 WU 落档 metadata（snapshot.metadata 为 JSON 字符串） */
async function getWuMetadata(workUnitId: string): Promise<Record<string, unknown>> {
  const index = await fileStore.getIndex();
  const wu = index.find(w => w.id === workUnitId);
  return JSON.parse(wu!.metadata);
}

async function createDevProfile() {
  await fileStore.createProfile({
    id: 'agent-dev', name: 'dev', description: null, channels: '[]', status: 'active',
    createdAt: now(), updatedAt: now(),
  });
}

describe('WU metadata.fileRefs 落档 + 归属 rung（#285，决策 #249 §4）', () => {
  it('@mention 建 WU：kept refs 原样写入 WU metadata.fileRefs（失效引用不进）', async () => {
    await createDevProfile();
    const message = await routeMessage(channelId, '@dev 看文件', undefined, fileStore, {
      files: [
        { repo: '/repo/default', path: 'src/a.ts' },
        { repo: '/repo/default', path: 'gone.ts' },
      ],
      fileRefDeps: makeDeps(),
    });

    const metadata = await getWuMetadata(message.workUnitId!);
    expect(metadata.fileRefs).toEqual([{ repo: '/repo/default', path: 'src/a.ts' }]);
  });

  it('@mention 建 WU：全部引用失效 → 不写 fileRefs 字段', async () => {
    await createDevProfile();
    const message = await routeMessage(channelId, '@dev 看文件', undefined, fileStore, {
      files: [{ repo: '/repo/default', path: 'gone.ts' }],
      fileRefDeps: makeDeps(),
    });

    const metadata = await getWuMetadata(message.workUnitId!);
    expect(metadata).not.toHaveProperty('fileRefs');
  });

  it('@mention 建 WU：kept refs 全同仓且与频道默认不同仓 → ownershipSource=file-refs + workspaceRoot 落档', async () => {
    await createDevProfile();
    // 候选集 = 频道默认 /repo/default ∪ 杂务 PMO /repo/chore；引用全部落在 /repo/chore
    const deps: FileRefVocabularyDeps = {
      ...makeDeps(),
      findChoreProject: async () => ({ gitRepo: '/repo/chore' }),
    };
    const message = await routeMessage(channelId, '@dev 看杂务仓文件', undefined, fileStore, {
      files: [{ repo: '/repo/chore/', path: 'src/a.ts' }], // 尾斜杠写法差，校验侧归一
      fileRefDeps: deps,
    });

    const metadata = await getWuMetadata(message.workUnitId!);
    expect(metadata.ownershipSource).toBe('file-refs');
    expect(metadata.workspaceRoot).toBe('/repo/chore');
    expect(metadata.fileRefs).toEqual([{ repo: '/repo/chore', path: 'src/a.ts' }]);
    // WU 主字段 workspaceId 不再取频道默认
    const index = await fileStore.getIndex();
    expect(index.find(w => w.id === message.workUnitId)!.workspaceId).toBeNull();
  });

  it('决策 12 channel-default 建 WU 路径：同样写 metadata.fileRefs（该路径不做归属解析）', async () => {
    await fileStore.updateChannel(channelId, { defaultProfileId: 'agent-dev' });
    await createDevProfile();
    const message = await routeMessage(channelId, '无 at 消息带文件', undefined, fileStore, {
      files: [{ repo: '/repo/default', path: 'README.md' }],
      fileRefDeps: makeDeps(),
    });

    expect(message.workUnitId).toBeTruthy();
    const metadata = await getWuMetadata(message.workUnitId!);
    expect(metadata.creationMode).toBe('channel-default');
    expect(metadata.fileRefs).toEqual([{ repo: '/repo/default', path: 'README.md' }]);
  });
});
