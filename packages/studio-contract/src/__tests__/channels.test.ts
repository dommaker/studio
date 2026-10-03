/**
 * channels 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 +
 * 与后端 wire 行为对齐的关键形状（正本 = channel.service.ts ChannelData + 路由实测）。
 */

import { describe, it, expect } from 'vitest';
import {
  channelSchema,
  type Channel,
  channelMessageSchema,
  type ChannelMessage,
  channelRoutingSchema,
  channelCurrentPmoSchema,
  channelPmoCandidateSchema,
  channelSuggestionsSchema,
  mergeTargetPreviewSchema,
  channelFileVocabularySchema,
  convertSuggestionSchema,
  savedImageSchema,
  listChannelMessagesQuerySchema,
  channelIdParamsSchema,
  attachmentParamsSchema,
  channelMessageParamsSchema,
  createChannelBodySchema,
  sendChannelMessageBodySchema,
  updateChannelBodySchema,
  updateChannelMembersBodySchema,
  uploadAttachmentBodySchema,
  convertToTaskBodySchema,
  channelListResponseSchema,
  channelResponseSchema,
  channelCurrentPmoResponseSchema,
  channelMessagesResultSchema,
  type ChannelMessagesResult,
  channelMessagesResponseSchema,
  deleteChannelResultSchema,
  archiveChannelResultSchema,
  restoreChannelResultSchema,
  updateMembersResultSchema,
  convertToTaskResponseSchema,
} from '../channels.js';
import * as contractIndex from '../index.js';

/** 后端 ChannelData 全字段最小合法形状（interface 类型即 parity 被测对象） */
const channelRow: Channel = {
  id: 'ch-1',
  name: '#研发',
  type: 'rnd',
  defaultWorkspaceId: null,
  defaultPath: null,
  discordChannelId: null,
  discordWebhookUrl: null,
  members: '[]',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

/** REST 出口消息形状（meta 已 JSON.parse 为 object） */
const messageRow: ChannelMessage = {
  id: 'm-1',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'human',
  agentName: null,
  content: 'hi',
  replyToId: null,
  meta: {},
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('channelSchema', () => {
  it('接受后端 wire 形状（含可选 routing）', () => {
    expect(channelSchema.parse(channelRow)).toEqual(channelRow);
    expect(channelSchema.parse({ ...channelRow, routing: { plan: 'p-1', implement: null } }).routing)
      .toEqual({ plan: 'p-1', implement: null });
  });

  it('缺必填字段 → 拒绝', () => {
    const { members: _m, ...noMembers } = channelRow;
    expect(channelSchema.safeParse(noMembers).success).toBe(false);
    expect(channelSchema.safeParse({ ...channelRow, defaultPath: undefined }).success).toBe(false);
  });

  // strict:false 仓 z.infer 全字段退化可选 → Channel 是手写 interface；parity 兜漂移
  it('parity：Channel interface fixture 全键 = schema.shape 键且通过校验', () => {
    const full: Channel & Required<Pick<Channel, 'routing'>> = {
      ...channelRow,
      routing: { plan: null },
    };
    expect(channelSchema.parse(full)).toEqual(full);
    expect(Object.keys(channelSchema.shape).sort()).toEqual(Object.keys(full).sort());
  });

  it('parity：interface 必填字段逐一删除 → schema 拒绝（必填集对齐）', () => {
    for (const key of Object.keys(channelRow)) {
      const { [key]: _drop, ...rest } = channelRow as unknown as Record<string, unknown>;
      expect(channelSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('channelMessageSchema', () => {
  it('接受 REST 出口形状（meta object）与 SSE/存量形态（meta string）', () => {
    expect(channelMessageSchema.parse(messageRow)).toEqual(messageRow);
    expect(channelMessageSchema.parse({ ...messageRow, meta: '{"a":1}' }).meta).toBe('{"a":1}');
  });

  it('parity：ChannelMessage interface fixture 全键 = schema.shape 键；必填字段删除即拒', () => {
    expect(Object.keys(channelMessageSchema.shape).sort()).toEqual(Object.keys(messageRow).sort());
    for (const key of Object.keys(messageRow)) {
      const { [key]: _drop, ...rest } = messageRow as unknown as Record<string, unknown>;
      expect(channelMessageSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('请求 schema', () => {
  it('create body：name trim 后必填；type 缺省 rnd、非法值拒绝', () => {
    expect(createChannelBodySchema.parse({ name: ' x ' })).toEqual({ name: 'x', type: 'rnd' });
    expect(createChannelBodySchema.parse({ name: 'a', type: 'decision' }).type).toBe('decision');
    expect(createChannelBodySchema.safeParse({}).success).toBe(false);
    expect(createChannelBodySchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(createChannelBodySchema.safeParse({ name: 'a', type: 'chat' }).success).toBe(false);
    expect(createChannelBodySchema.safeParse({ name: 'a', type: null }).success).toBe(false);
  });

  it('create body：agents/members/defaultPath 可选透传', () => {
    const parsed = createChannelBodySchema.parse({
      name: 'a', agents: [{ name: 'ceo', description: null }], members: ['p-1'], defaultPath: null,
    });
    expect(parsed.agents).toEqual([{ name: 'ceo', description: null }]);
    expect(parsed.members).toEqual(['p-1']);
    expect(parsed.defaultPath).toBeNull();
  });

  it('send message body：content trim 非空；intent 枚举；files 须 {repo,path} 非空串', () => {
    expect(sendChannelMessageBodySchema.parse({ content: ' hi ' }).content).toBe('hi');
    expect(sendChannelMessageBodySchema.safeParse({ content: '  ' }).success).toBe(false);
    expect(sendChannelMessageBodySchema.safeParse({ content: 'x', intent: 'bogus' }).success).toBe(false);
    expect(sendChannelMessageBodySchema.parse({ content: 'x', intent: 'new-task' }).intent).toBe('new-task');
    expect(sendChannelMessageBodySchema.safeParse({ content: 'x', files: [{ repo: '', path: 'a' }] }).success).toBe(false);
    expect(sendChannelMessageBodySchema.safeParse({ content: 'x', files: [{ repo: 'r' }] }).success).toBe(false);
    expect(sendChannelMessageBodySchema.parse({ content: 'x', files: [{ repo: 'r', path: 'p' }] }).files)
      .toEqual([{ repo: 'r', path: 'p' }]);
  });

  it('update body：全可选；routing 透传 record（未知阶段键由 handler validateRouting 拒）', () => {
    expect(updateChannelBodySchema.parse({})).toEqual({});
    expect(updateChannelBodySchema.parse({ routing: { plan: 'p-1', review: null } }).routing)
      .toEqual({ plan: 'p-1', review: null });
    expect(updateChannelBodySchema.safeParse({ defaultPath: 123 }).success).toBe(false);
    expect(updateChannelBodySchema.parse({ defaultPath: null }).defaultPath).toBeNull();
    // defaultWorkspaceId 保持 z.unknown：'' / null / 非字符串的归一在 validateDefaultWorkspaceId（旧行为不变）
    expect(updateChannelBodySchema.parse({ defaultWorkspaceId: '' }).defaultWorkspaceId).toBe('');
  });

  it('members body：add/remove 为字符串数组（非数组 → 400 收紧，旧代码会把字符串摊开成字符）', () => {
    expect(updateChannelMembersBodySchema.parse({ add: ['a'], remove: ['b'] })).toEqual({ add: ['a'], remove: ['b'] });
    expect(updateChannelMembersBodySchema.parse({})).toEqual({});
    expect(updateChannelMembersBodySchema.safeParse({ add: 'ab' }).success).toBe(false);
  });

  it('messages query：全可选透传；params 非空', () => {
    expect(listChannelMessagesQuerySchema.parse({})).toEqual({});
    expect(listChannelMessagesQuerySchema.parse({ before: 'm-1', limit: '50', includeTotal: 'true' }))
      .toEqual({ before: 'm-1', limit: '50', includeTotal: 'true' });
    expect(channelIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(attachmentParamsSchema.parse({ id: 'c', attachmentId: 'a.png' })).toEqual({ id: 'c', attachmentId: 'a.png' });
    expect(channelMessageParamsSchema.safeParse({ id: 'c' }).success).toBe(false);
  });

  it('attachment/convert body：宽松可选（领域校验在 service，含 413 等非 400 状态）', () => {
    expect(uploadAttachmentBodySchema.parse({})).toEqual({});
    expect(convertToTaskBodySchema.parse({})).toEqual({});
    expect(convertToTaskBodySchema.safeParse({ title: 1 }).success).toBe(false);
  });
});

describe('派生读与响应 schema', () => {
  it('派生形状：current-pmo / pmo-candidates / suggestions / merge-target / vocabulary', () => {
    expect(channelCurrentPmoSchema.parse({ id: 'p', pmoNumber: 'PMO-1', title: 't', gitRepos: [] })).toBeTruthy();
    expect(channelPmoCandidateSchema.safeParse({ id: 'p', pmoNumber: 'PMO-1' }).success).toBe(false);
    expect(channelSuggestionsSchema.parse({ currentWuId: null, suggestions: [] })).toBeTruthy();
    expect(channelSuggestionsSchema.parse({
      currentWuId: 'wu-1',
      suggestions: [{ id: 's', kind: 'prompt', params: {}, text: 'do' }],
      degraded: true,
    }).suggestions[0]?.kind).toBe('prompt');
    expect(channelSuggestionsSchema.safeParse({
      currentWuId: null, suggestions: [{ id: 's', kind: 'bogus', params: {} }],
    }).success).toBe(false);
    expect(mergeTargetPreviewSchema.parse({ status: 'none' })).toEqual({ status: 'none' });
    expect(mergeTargetPreviewSchema.parse({ status: 'unique', workUnit: { id: 'w', title: 't' } }).workUnit)
      .toEqual({ id: 'w', title: 't' });
    expect(channelFileVocabularySchema.parse({ repos: [{ repo: '/r', files: ['a.ts'] }] })).toBeTruthy();
    expect(convertSuggestionSchema.parse({})).toEqual({});
    expect(savedImageSchema.parse({ id: 'a.png', url: '/u', size: 1 })).toBeTruthy();
  });

  it('响应壳：{ data } 统一；messages 为 { data: { messages, total, hasMore } }', () => {
    expect(channelListResponseSchema.parse({ data: [channelRow] }).data).toHaveLength(1);
    expect(channelResponseSchema.parse({ data: channelRow }).data.id).toBe('ch-1');
    expect(channelCurrentPmoResponseSchema.parse({ data: null }).data).toBeNull();
    const page = { messages: [messageRow], total: 10, hasMore: true };
    expect(channelMessagesResponseSchema.parse({ data: page }).data.messages).toHaveLength(1);
    expect(channelMessagesResultSchema.safeParse({ messages: [], hasMore: true }).success).toBe(false);
    expect(deleteChannelResultSchema.parse({ deleted: true, fallbackChannelId: 'ch-2' })).toBeTruthy();
    expect(archiveChannelResultSchema.parse({ archived: true, newName: '#x-archived-1' })).toBeTruthy();
    expect(restoreChannelResultSchema.parse({ restored: true, name: '#x' })).toBeTruthy();
    expect(updateMembersResultSchema.parse({ members: ['a'] })).toEqual({ members: ['a'] });
    expect(updateMembersResultSchema.parse({ members: [], warning: 'w' }).warning).toBe('w');
  });

  it('parity：ChannelMessagesResult interface（手写，store 按必填消费）↔ schema 互验', () => {
    const result: ChannelMessagesResult = { messages: [messageRow], total: 1, hasMore: false };
    expect(channelMessagesResultSchema.parse(result)).toEqual(result);
    expect(Object.keys(channelMessagesResultSchema.shape).sort()).toEqual(Object.keys(result).sort());
    for (const key of Object.keys(result)) {
      const { [key]: _drop, ...rest } = result as unknown as Record<string, unknown>;
      expect(channelMessagesResultSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });

  it('convert-to-task 响应复用 workunit 实体壳', () => {
    expect(convertToTaskResponseSchema.safeParse({ data: { id: 'wu-1' } }).success).toBe(false);
  });

  it('index.ts 出口包含 channels 域 schema', () => {
    expect(contractIndex.channelSchema).toBe(channelSchema);
    expect(contractIndex.createChannelBodySchema).toBe(createChannelBodySchema);
    expect(contractIndex.channelRoutingSchema).toBe(channelRoutingSchema);
  });
});
