// #688：mention 匹配纯函数单元测试（自 message-routing.ts 内联逻辑拆出为 mention-match.ts）。
// 行为口径锁定：§9.5 成员界匹配、members 空回退全量、系统角色不参与、
// #496 手打中文连写最长前缀兜底（等长歧义回退未匹配）、scope 剥离两种口径。
import { describe, it, expect } from 'vitest';
import { detectMention, matchMentionAgent, stripMentionScope } from '../mention-match.js';

const profile = (id: string, name: string, kind?: 'system') => ({ id, name, ...(kind ? { kind } : {}) });

describe('detectMention', () => {
  it('检测英文 @mention', () => {
    expect(detectMention('@developer 看下这个')).toBe('developer');
  });

  it('检测中文 @mention（\\p{L} 放宽）', () => {
    expect(detectMention('@开发 你好')).toBe('开发');
  });

  it('手打中文连写：token 整体作为 mentionName 返回', () => {
    expect(detectMention('@开发你好')).toBe('开发你好');
  });

  it('无 @mention 返回 null', () => {
    expect(detectMention('普通消息')).toBeNull();
  });
});

describe('matchMentionAgent（§9.5 成员界 + #496 前缀兜底）', () => {
  const members = (ids: string[]) => ({ members: JSON.stringify(ids) });

  it('精确匹配命中本频道成员', () => {
    const dev = profile('p1', 'developer');
    const { agent, prefixMatchName } = matchMentionAgent([dev], 'developer', members(['p1']));
    expect(agent?.id).toBe('p1');
    expect(prefixMatchName).toBeNull();
  });

  it('成员界：profile 非本频道成员 → 不匹配', () => {
    const dev = profile('p1', 'developer');
    const { agent } = matchMentionAgent([dev], 'developer', members(['p2']));
    expect(agent).toBeNull();
  });

  it('members 为空 → 回退全量匹配（历史频道未回填）', () => {
    const dev = profile('p1', 'developer');
    const { agent } = matchMentionAgent([dev], 'developer', members([]));
    expect(agent?.id).toBe('p1');
  });

  it('系统角色不参与精确匹配（@studio → null）', () => {
    const studio = profile('sys', 'studio', 'system');
    const { agent } = matchMentionAgent([studio], 'studio', members(['sys']));
    expect(agent).toBeNull();
  });

  it('#496 前缀兜底：@开发你好 命中成员「开发」，prefixMatchName 落正名', () => {
    const dev = profile('p1', '开发');
    const { agent, prefixMatchName } = matchMentionAgent([dev], '开发你好', members(['p1']));
    expect(agent?.id).toBe('p1');
    expect(prefixMatchName).toBe('开发');
  });

  it('#496 前缀兜底：多成员互为前缀取最长', () => {
    const short = profile('p1', '开发');
    const long = profile('p2', '开发组');
    const { agent, prefixMatchName } = matchMentionAgent([short, long], '开发组你好', members(['p1', 'p2']));
    expect(agent?.id).toBe('p2');
    expect(prefixMatchName).toBe('开发组');
  });

  it('#496 前缀兜底：等长歧义（同名 profile 并列最长）→ 回退未匹配', () => {
    const a = profile('p1', '开发');
    const b = profile('p2', '开发');
    const { agent, prefixMatchName } = matchMentionAgent([a, b], '开发你好', members(['p1', 'p2']));
    expect(agent).toBeNull();
    expect(prefixMatchName).toBeNull();
  });

  it('系统角色不参与前缀兜底（@studioxxx 不命中 studio）', () => {
    const studio = profile('sys', 'studio', 'system');
    const { agent } = matchMentionAgent([studio], 'studioxxx', members(['sys']));
    expect(agent).toBeNull();
  });

  it('channel 缺省/无 members 字段 → 按空成员回退全量', () => {
    const dev = profile('p1', 'developer');
    const { agent } = matchMentionAgent([dev], 'developer', null);
    expect(agent?.id).toBe('p1');
  });
});

describe('stripMentionScope', () => {
  it('精确匹配/未匹配：剥整个 @token', () => {
    expect(stripMentionScope('@developer 看下这个', null)).toBe('看下这个');
  });

  it('#496 前缀命中：只剥 @成员名，保留连写剩余文本', () => {
    expect(stripMentionScope('@开发你好', '开发')).toBe('你好');
  });
});
