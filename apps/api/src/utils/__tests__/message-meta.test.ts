// parseMessageMeta：消息 meta object×string 双型解析（#264 口径 ——
// 与前端 apps/web/src/utils/messageMeta.ts parseMeta 同一逻辑的后端正本）。
import { describe, it, expect } from 'vitest';
import { parseMessageMeta } from '../message-meta.js';

describe('parseMessageMeta（meta object×string 双型兼容）', () => {
  it('object 直接取用（同一引用）', () => {
    const meta = { cardType: 'auditor_suggestion', status: 'pending' };
    expect(parseMessageMeta(meta)).toBe(meta);
  });

  it('string → JSON.parse', () => {
    expect(parseMessageMeta('{"cardType":"auditor_suggestion"}'))
      .toEqual({ cardType: 'auditor_suggestion' });
  });

  it('空串/null/undefined → {}', () => {
    expect(parseMessageMeta('')).toEqual({});
    expect(parseMessageMeta(null)).toEqual({});
    expect(parseMessageMeta(undefined)).toEqual({});
  });

  it('string 解析失败 → {} 兜底不抛出（与前端 parseMeta 口径一致）', () => {
    expect(parseMessageMeta('{broken')).toEqual({});
  });
});
