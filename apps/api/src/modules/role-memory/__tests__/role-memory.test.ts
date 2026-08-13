/**
 * role-memory (#98) — 角色记忆存储服务接口级测试
 *
 * 覆盖（对应 #98 AC）：
 *   ① per-role MEMORY.md 索引 / topics/*.md / draft.jsonl 三件套可读写；
 *   ② 多 WU 并行 append 草稿无冲突（append-only JSONL）；
 *   ③ promote 合并单路径 + 同角色进程内互斥；
 *   ④ 容量超限产生提醒（超限不落新人罪、不自动删）；
 *   ⑤ 接口级测试覆盖以上行为。
 *
 * 不测内部实现细节（FileStore 读写原语由 studio-shared 单测覆盖）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  roleMemoryDir,
  sanitizeRoleId,
  sanitizeTopicSlug,
  RoleMemoryStore,
  type MemoryDraftEntry,
} from '../role-memory.js';

// 测试环境隔离目录（同 transcript-archive / studio-log-path 约定）：不写生产 ~/.studio
const TEST_ROOT = path.join(os.tmpdir(), 'studio-test-role-memory');

/** 每用例唯一角色 id，防跨用例碰撞 */
function freshRoleId(prefix = 'role'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const store = new RoleMemoryStore();

afterEach(() => {
  // 清理本用例写入的角色目录（roleId 唯一，按根目录整体清更稳）
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('sanitizeRoleId / sanitizeTopicSlug（防路径穿越）', () => {
  it('合法角色 id 原样返回', () => {
    expect(sanitizeRoleId('role-1')).toBe('role-1');
    expect(sanitizeRoleId('d64e0b99-510b-45c4-9e2b-285db0d38309')).toBe('d64e0b99-510b-45c4-9e2b-285db0d38309');
  });

  it('拒绝路径穿越角色 id', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../etc', 'a..b/..']) {
      expect(() => sanitizeRoleId(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('拒绝路径穿越 topic slug', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', '../x']) {
      expect(() => sanitizeTopicSlug(bad), `should reject ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('合法 topic slug 原样返回', () => {
    expect(sanitizeTopicSlug('debugging')).toBe('debugging');
  });
});

describe('roleMemoryDir（路径：生产经 studioPath，测试隔离）', () => {
  const withHome = (home: string | undefined, fn: () => void): void => {
    const prev = process.env.STUDIO_HOME;
    if (home === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = home;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = prev;
    }
  };

  it('生产路径经 studioPath()：STUDIO_HOME/memory/<roleId>', () => {
    withHome('/tmp/fake-studio-home', () => {
      expect(roleMemoryDir('r1', {})).toBe(path.join('/tmp/fake-studio-home', 'memory', 'r1'));
    });
  });

  it('测试环境 → os.tmpdir()/studio-test-role-memory/<roleId>（隔离，不写生产路径）', () => {
    expect(roleMemoryDir('r1', { VITEST: 'true' })).toBe(path.join(TEST_ROOT, 'r1'));
    expect(roleMemoryDir('r1', { NODE_ENV: 'test' })).toBe(path.join(TEST_ROOT, 'r1'));
  });
});

describe('草稿区读写（append-only JSONL）', () => {
  it('appendDraft → readDraft 往返，字段完整', async () => {
    const roleId = freshRoleId();
    const entry = await store.appendDraft(roleId, {
      kind: 'execution-knowledge',
      title: '测试命令',
      content: '本项目测试命令是 `pnpm test:api`。',
      topicSlug: 'testing',
    });
    expect(entry.id).toBeTruthy();
    expect(entry.roleId).toBe(roleId);

    const drafts = await store.readDraft(roleId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: 'execution-knowledge',
      title: '测试命令',
      content: '本项目测试命令是 `pnpm test:api`。',
      topicSlug: 'testing',
    });
    expect(typeof drafts[0].createdAt).toBe('string');
  });

  it('空草稿区 → readDraft 返回 []（不抛出）', async () => {
    await expect(store.readDraft(freshRoleId('empty'))).resolves.toEqual([]);
  });

  it('多 WU 并行 append 无冲突：50 并发 append 全部落盘', async () => {
    const roleId = freshRoleId();
    const inputs = Array.from({ length: 50 }, (_, i) => ({
      kind: 'execution-knowledge' as const,
      title: `坑-${i}`,
      content: `第 ${i} 条并行草稿内容`,
    }));
    await Promise.all(inputs.map(input => store.appendDraft(roleId, input)));

    const drafts = await store.readDraft(roleId);
    expect(drafts).toHaveLength(50);
    const titles = new Set(drafts.map(d => d.title));
    expect(titles.size).toBe(50);
  });

  it('拒绝非法记忆类型（只收执行知识/偏好两类）', async () => {
    const roleId = freshRoleId();
    await expect(store.appendDraft(roleId, {
      kind: 'decision' as never,
      title: 'x',
      content: 'x',
    })).rejects.toThrow();
  });
});

describe('索引 / topic 读写', () => {
  it('无 promote 时 readIndex 返回空串、readTopic 返回 null', async () => {
    const roleId = freshRoleId();
    await expect(store.readIndex(roleId)).resolves.toBe('');
    await expect(store.readTopic(roleId, 'testing')).resolves.toBeNull();
  });
});

describe('promote 合并（单路径 + 同角色互斥）', () => {
  it('promote 把草稿条目合并进 topic + 索引（单一代码路径）', async () => {
    const roleId = freshRoleId();
    const e1 = await store.appendDraft(roleId, {
      kind: 'execution-knowledge',
      title: 'Testing command',
      content: '本项目测试命令是 `pnpm test:api`。',
    });
    const e2 = await store.appendDraft(roleId, {
      kind: 'preference',
      title: 'Naming conventions',
      content: '分支名用 feat/<n>-<slug>。',
    });

    const result = await store.promote(roleId, [e1.id, e2.id]);
    expect(result.promoted).toBe(2);
    expect(result.topicsUpdated).toHaveLength(2);

    // topic 可读（slug 由 title 推导）
    const topic1 = await store.readTopic(roleId, 'testing-command');
    expect(topic1).not.toBeNull();
    expect(topic1?.body).toContain('pnpm test:api');
    const topic2 = await store.readTopic(roleId, 'naming-conventions');
    expect(topic2?.body).toContain('feat/<n>-<slug>');

    // 索引包含两条 topic 指针行
    const index = await store.readIndex(roleId);
    expect(index).toContain('[testing-command](topics/testing-command.md)');
    expect(index).toContain('[naming-conventions](topics/naming-conventions.md)');
  });

  it('同 topicSlug 的多条草稿合并进同一 topic（body 含全部段落）', async () => {
    const roleId = freshRoleId();
    const e1 = await store.appendDraft(roleId, { kind: 'execution-knowledge', title: 'A', content: 'content-A', topicSlug: 'shared' });
    const e2 = await store.appendDraft(roleId, { kind: 'execution-knowledge', title: 'B', content: 'content-B', topicSlug: 'shared' });

    const result = await store.promote(roleId, [e1.id, e2.id]);
    expect(result.topicsUpdated).toEqual(['shared']);

    const topic = await store.readTopic(roleId, 'shared');
    expect(topic?.body).toContain('content-A');
    expect(topic?.body).toContain('content-B');

    // 索引只有一行（同一 topic）
    const index = await store.readIndex(roleId);
    const topicLines = index.split('\n').filter(l => l.startsWith('- ['));
    expect(topicLines).toHaveLength(1);
  });

  it('promote 后 readDraft 排除已 promote 条目', async () => {
    const roleId = freshRoleId();
    const e1 = await store.appendDraft(roleId, { kind: 'execution-knowledge', title: 'A', content: 'a' });
    const e2 = await store.appendDraft(roleId, { kind: 'execution-knowledge', title: 'B', content: 'b' });

    await store.promote(roleId, [e1.id]);
    const drafts = await store.readDraft(roleId);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe(e2.id);
  });

  it('promote 未知 id → promoted 0，不抛错', async () => {
    const roleId = freshRoleId();
    await expect(store.promote(roleId, ['no-such-id'])).resolves.toMatchObject({ promoted: 0 });
  });

  it('同角色并发 promote 互斥：20 并发合并全部落盘无丢失', async () => {
    const roleId = freshRoleId();
    const entries: MemoryDraftEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push(await store.appendDraft(roleId, {
        kind: 'execution-knowledge',
        title: `并发-${i}`,
        content: `content-${i}`,
        topicSlug: 'parallel',
      }));
    }

    await Promise.all(entries.map(e => store.promote(roleId, [e.id])));

    const topic = await store.readTopic(roleId, 'parallel');
    expect(topic).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      expect(topic?.body, `missing content-${i}`).toContain(`content-${i}`);
    }
    // 全部已 promote，无残留 pending
    await expect(store.readDraft(roleId)).resolves.toEqual([]);
  });
});

describe('容量检查（超限提醒，不自动删、不落新人罪）', () => {
  it('topic 数超限 → overLimit 且含 topics violation', async () => {
    const small = new RoleMemoryStore({ maxTopics: 1, maxPendingDrafts: 100 });
    const roleId = freshRoleId();
    const e1 = await small.appendDraft(roleId, { kind: 'execution-knowledge', title: 'A', content: 'a' });
    const e2 = await small.appendDraft(roleId, { kind: 'execution-knowledge', title: 'B', content: 'b' });
    await small.promote(roleId, [e1.id, e2.id]); // 两个不同 slug → 2 topics

    const check = await small.checkCapacity(roleId);
    expect(check.overLimit).toBe(true);
    expect(check.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'topics', current: 2, limit: 1 }),
    ]));
  });

  it('pending 草稿数超限 → overLimit 且含 draft violation', async () => {
    const small = new RoleMemoryStore({ maxTopics: 10, maxPendingDrafts: 2 });
    const roleId = freshRoleId();
    for (let i = 0; i < 3; i++) {
      await small.appendDraft(roleId, { kind: 'execution-knowledge', title: `D-${i}`, content: `d-${i}` });
    }

    const check = await small.checkCapacity(roleId);
    expect(check.overLimit).toBe(true);
    expect(check.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'draft', current: 3, limit: 2 }),
    ]));
  });

  it('容量内 → overLimit false 且无 violation', async () => {
    const small = new RoleMemoryStore({ maxTopics: 10, maxPendingDrafts: 10 });
    const roleId = freshRoleId();
    await small.appendDraft(roleId, { kind: 'execution-knowledge', title: 'A', content: 'a' });
    const check = await small.checkCapacity(roleId);
    expect(check.overLimit).toBe(false);
    expect(check.violations).toEqual([]);
  });

  it('超限不落新人罪：超限后 appendDraft 仍成功（提醒而非拒绝）', async () => {
    const small = new RoleMemoryStore({ maxTopics: 10, maxPendingDrafts: 1 });
    const roleId = freshRoleId();
    await small.appendDraft(roleId, { kind: 'execution-knowledge', title: 'A', content: 'a' });
    // 已超限（pending 1 == limit 1，不超；再 append 一条超限）
    await small.appendDraft(roleId, { kind: 'execution-knowledge', title: 'B', content: 'b' });
    const check = await small.checkCapacity(roleId);
    expect(check.overLimit).toBe(true);
    // 仍能继续写（不拒绝新记忆）
    await expect(small.appendDraft(roleId, { kind: 'preference', title: 'C', content: 'c' })).resolves.toBeTruthy();
  });
});
