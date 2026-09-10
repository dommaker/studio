/**
 * #469：postProjectMilestone（delivery-notify）单元测试
 *
 * 覆盖：有 channelId → 频道消息（meta pmoId+atHuman）+ 持久通知（/pmo/project/:id 直链）双写；
 *       无 channelId → 只落通知不发帖；任一面失败 best-effort 不抛错。
 * 端到端出口（progress-rollup 翻转 / deliver 播报 / markProjectDelivered）由各自测试兜底。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { postProjectMilestone } from '../delivery-notify.js';

let fileStore: FileStore;

beforeEach(() => {
  fileStore = new FileStore(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pmo-milestone-')));
});

function seedUser(userId: string): void {
  const usersDir = path.join(process.env.STUDIO_DATA_DIR!, 'users');
  fs.mkdirSync(usersDir, { recursive: true });
  fs.writeFileSync(path.join(usersDir, `${userId}.json`), '{}');
}

describe('postProjectMilestone（#469 项目里程碑出声）', () => {
  it('有 channelId → 频道系统消息（Studio，meta pmoId+atHuman）+ 持久通知（link 直链）', async () => {
    seedUser('u1');
    await postProjectMilestone(
      { id: 'proj-1', pmoNumber: 'PMO-42', channelId: 'ch-1' },
      { title: 'PMO-42 已收尾（completed）', content: '✅ PMO-42 已收尾' },
      { fileStore },
    );

    const msgs = await fileStore.queryMessages('ch-1', {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0].authorType).toBe('agent');
    expect(msgs[0].agentName).toBe('Studio');
    expect(msgs[0].content).toBe('✅ PMO-42 已收尾');
    const meta = typeof msgs[0].meta === 'string' ? JSON.parse(msgs[0].meta) : msgs[0].meta;
    expect(meta).toMatchObject({ pmoId: 'proj-1', atHuman: true });

    const notifications = await new NotificationService(fileStore).getUserNotifications('u1');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'system',
      title: 'PMO-42 已收尾（completed）',
      link: '/pmo/project/proj-1',
      channelId: 'ch-1',
    });
  });

  it('无 channelId → 不发帖，通知照落（link 直链不变）', async () => {
    seedUser('u2');
    await postProjectMilestone(
      { id: 'proj-2', pmoNumber: 'PMO-7', channelId: null },
      { title: 'PMO-7 已交付', content: '📦 PMO-7 已交付' },
      { fileStore },
    );

    const notifications = await new NotificationService(fileStore).getUserNotifications('u2');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].link).toBe('/pmo/project/proj-2');
    expect(notifications[0].channelId).toBeNull();
  });

  it('频道面失败（appendMessage 抛错）best-effort 不抛错，通知面仍落', async () => {
    seedUser('u3');
    // 只打断频道面（消息按频道落文件），通知面 appendJsonl 不受影响
    const origAppend = fileStore.appendMessage.bind(fileStore);
    fileStore.appendMessage = (async () => { throw new Error('disk full'); }) as typeof origAppend;

    await expect(postProjectMilestone(
      { id: 'proj-3', pmoNumber: 'PMO-9', channelId: 'ch-x' },
      { title: 't', content: 'c' },
      { fileStore },
    )).resolves.toBeUndefined();

    const notifications = await new NotificationService(fileStore).getUserNotifications('u3');
    expect(notifications).toHaveLength(1);
  });
});
