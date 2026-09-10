// Trigger 指名执行者可运行性启动自检（2026-09-10）——
// 背景：doc-semantic-review 指名 studio（无 loop 的署名身份），建单即结构性死单滞留 143h。
// 自检在启动挂载 loop 后跑：CREATE 类 trigger 的 assigneeRole 必须解析到「存在且 loop 在跑」的角色。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { checkTriggerAssignees } from '../trigger-assignee-check';
import type { TriggerConfig } from '../trigger.types';

function makeTrigger(id: string, assigneeRole?: string): TriggerConfig {
  return {
    id,
    name: id,
    condition: { type: 'SCHEDULE', cron: '0 9 * * 5' },
    action: assigneeRole
      ? { type: 'CREATE', target: 'WorkUnit', payload: { type: 'analysis', scope: 'x', assigneeRole } }
      : { type: 'CREATE', target: 'WorkUnit', payload: { type: 'analysis', scope: 'x' } },
    enabled: true,
    scope: 'system',
  };
}

describe('checkTriggerAssignees — trigger 指名角色可运行性自检', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-assignee-check-'));
    fileStore = new FileStore(tmpDir);
    const now = new Date().toISOString();
    await fileStore.createProfile({
      id: 'p-studio', name: 'studio', description: null,
      channels: '[]', provider: 'claude', status: 'active',
      createdAt: now, updatedAt: now,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('指名角色存在且 loop running → 无问题', async () => {
    const problems = await checkTriggerAssignees([makeTrigger('t1', 'studio')], {
      fileStore,
      getLoopEntry: (id) => (id === 'p-studio' ? { status: 'running' } : undefined),
    });
    expect(problems).toEqual([]);
  });

  it('无 assigneeRole 的 trigger（频道竞争认领）不参与自检', async () => {
    const problems = await checkTriggerAssignees([makeTrigger('t1')], {
      fileStore,
      getLoopEntry: () => undefined,
    });
    expect(problems).toEqual([]);
  });

  it('指名角色不存在 → 报问题（创建时会回退 unassigned，但配置意图已丢失）', async () => {
    const problems = await checkTriggerAssignees([makeTrigger('t1', 'ghost')], {
      fileStore,
      getLoopEntry: () => undefined,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ triggerId: 't1', assigneeRole: 'ghost' });
    expect(problems[0].reason).toMatch(/not found|不存在/);
  });

  it('角色存在但 loop 未挂载（无 entry）→ 报问题（指名 WU 无人能领）', async () => {
    const problems = await checkTriggerAssignees([makeTrigger('t1', 'studio')], {
      fileStore,
      getLoopEntry: () => undefined,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ triggerId: 't1', assigneeRole: 'studio' });
    expect(problems[0].reason).toMatch(/loop/i);
  });

  it('角色存在但 loop 挂载失败（failed/skipped）→ 报问题', async () => {
    for (const status of ['failed', 'skipped'] as const) {
      const problems = await checkTriggerAssignees([makeTrigger('t1', 'studio')], {
        fileStore,
        getLoopEntry: () => ({ status }),
      });
      expect(problems).toHaveLength(1);
      expect(problems[0].reason).toContain(status);
    }
  });

  it('多个 trigger 指名同一故障角色 → 逐个报（各自可定位）', async () => {
    const problems = await checkTriggerAssignees(
      [makeTrigger('t1', 'studio'), makeTrigger('t2', 'studio')],
      { fileStore, getLoopEntry: () => undefined },
    );
    expect(problems.map(p => p.triggerId)).toEqual(['t1', 't2']);
  });
});
