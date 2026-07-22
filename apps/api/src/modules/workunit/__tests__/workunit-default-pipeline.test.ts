/**
 * AC-6.3: workunit.service.create() 频道默认管线展开
 *
 * D10: 频道默认管线只展开第一跳，后续靠 agent DELEGATE。
 * 规则：type='feature' + channel.defaultPipeline 存在且非空
 *       -> 创建链头子 WU (type=pipeline[0], parentId=父.id, assigneeId=profile.id, status='unassigned')
 * 无 defaultPipeline 时不展开。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';

describe('AC-6.3: WorkUnit create() defaultPipeline expansion', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let service: WorkUnitService;
  let channelId: string;
  let channelNoPipelineId: string;
  let executorProfileId: string;
  let reviewerProfileId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-pipeline-test-'));
    fileStore = new FileStore(tmpDir);
    service = new WorkUnitService(fileStore);

    const now = new Date().toISOString();

    // Seed active profiles
    executorProfileId = 'p-exec-wu';
    reviewerProfileId = 'p-rev-wu';
    for (const p of [
      { id: executorProfileId, name: 'executor' },
      { id: reviewerProfileId, name: 'reviewer' },
    ]) {
      await fileStore.createProfile({
        id: p.id, name: p.name, description: null,
        channels: '[]', status: 'active', createdAt: now, updatedAt: now,
      });
    }

    // Channel with defaultPipeline
    channelId = 'ch-pipeline';
    await fileStore.createChannel({
      id: channelId, name: '#test-pipeline', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', defaultPipeline: ['executor', 'reviewer'],
      createdAt: now, updatedAt: now,
    });

    // Channel without defaultPipeline
    channelNoPipelineId = 'ch-no-pipeline';
    await fileStore.createChannel({
      id: channelNoPipelineId, name: '#test-no-pipeline', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: now, updatedAt: now,
    });
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('type=feature + channel.defaultPipeline -> creates head child WU', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'implement feature X',
      channelId,
    });

    // Lookup child WUs
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(1);

    const child = children[0];
    expect(child.type).toBe('executor');          // pipeline[0] = profile name
    expect(child.assigneeId).toBe(executorProfileId);
    expect(child.status).toBe('unassigned');
    expect(child.channelId).toBe(channelId);
  });

  it('only expands first hop (D10): pipeline=[a,b] -> 1 child type=a', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'multi-step feature',
      channelId,
    });
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(1);
    expect(children[0].type).toBe('executor');    // first item only
  });

  it('type=feature + no defaultPipeline -> no child WU', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature without pipeline',
      channelId: channelNoPipelineId,
    });
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(0);
  });

  it('type=feature + empty defaultPipeline -> no child WU', async () => {
    const now = new Date().toISOString();
    const emptyPipelineChId = 'ch-empty-pipeline';
    await fileStore.createChannel({
      id: emptyPipelineChId, name: '#test-empty-pipeline', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', defaultPipeline: [],
      createdAt: now, updatedAt: now,
    });

    const parent = await service.create({
      type: 'feature',
      scope: 'feature with empty pipeline',
      channelId: emptyPipelineChId,
    });
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(0);
  });

  it('type=task + defaultPipeline -> no child WU (only feature expands)', async () => {
    const parent = await service.create({
      type: 'task',
      scope: 'task not feature',
      channelId,
    });
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(0);
  });

  it('type=feature + no channelId -> no child WU', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature no channel',
      channelId: null,
    });
    const all = await fileStore.getIndex();
    const children = all.filter(s => s.parentId === parent.id);
    expect(children.length).toBe(0);
  });

  it('child WU inherits collab metadata (rootId=parent.id, depth=1)', async () => {
    const parent = await service.create({
      type: 'feature',
      scope: 'feature collab check',
      channelId,
    });
    const all = await fileStore.getIndex();
    const child = all.find(s => s.parentId === parent.id);
    expect(child).toBeDefined();
    const meta = child!.metadata ? JSON.parse(child!.metadata) : {};
    expect(meta.collab).toBeDefined();
    expect(meta.collab.rootId).toBe(parent.id);
    expect(meta.collab.depth).toBe(1);
    expect(meta.collab.chain).toContain(executorProfileId);
  });
});
