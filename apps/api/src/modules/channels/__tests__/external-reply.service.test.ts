import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { workUnitSchema } from '@dommaker/studio-contract';
import { EffectService, postWuSystemMessage, toWorkUnitWire, WorkUnitService, type WorkUnitData } from '../../workunit/index.js';

const operator = { id: 'operator-1', type: 'Operator' } as const;

let tmpDir: string;
let store: FileStore;
let workUnits: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-reply-effect-'));
  store = new FileStore(tmpDir);
  workUnits = new WorkUnitService(store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createWorkUnit(): Promise<WorkUnitData> {
  return workUnits.create({
    scope: '持久外部回复', type: 'task', status: 'active', channelId: 'channel-1',
    authorization: { requestedBy: operator, source: { kind: 'api' } },
  });
}

describe('WU 外部回复 Effect', () => {
  it('提交后执行持久意图，并保存与可观察消息对应的 Receipt', async () => {
    const wu = await createWorkUnit();

    const message = await postWuSystemMessage(wu, '  已完成第一步  ', {
      fileStore: store, agentName: 'developer', replyToId: 'anchor-1', meta: { cardType: 'progress' },
    });

    expect(message).toMatchObject({
      channelId: 'channel-1', workUnitId: wu.id, agentName: 'developer',
      content: '已完成第一步', replyToId: 'anchor-1', meta: { cardType: 'progress' },
    });
    const projection = await new EffectService(store).getProjection(wu.id);
    expect(projection.effects).toHaveLength(1);
    expect(projection.effects[0]).toMatchObject({
      kind: 'external-reply', status: 'succeeded', attempts: 1,
      payload: {
        messageId: message!.id, channelId: 'channel-1', workUnitId: wu.id,
        agentName: 'developer', content: '已完成第一步', replyToId: 'anchor-1',
      },
    });
    expect(projection.receipts).toHaveLength(1);
    expect(projection.receipts[0]).toMatchObject({
      outcome: 'succeeded', result: { messageId: message!.id },
    });
    const readModel = await workUnits.getById(wu.id);
    expect(workUnitSchema.parse(toWorkUnitWire(readModel!)).effects?.[0]?.kind).toBe('external-reply');
  });
});
