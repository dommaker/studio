// utils/wuMeta（#358）：4 处逐字 try/catch 拷贝收口，模式对齐 #264 utils/messageMeta
import { describe, expect, it } from 'vitest';
import { parseWuMeta } from '../wuMeta';

describe('parseWuMeta', () => {
  it('合法 JSON → 解析产物', () => {
    expect(parseWuMeta('{"title":"t","stepCount":3}')).toEqual({ title: 't', stepCount: 3 });
  });

  it('null / undefined / 空串 → {}', () => {
    expect(parseWuMeta(null)).toEqual({});
    expect(parseWuMeta(undefined)).toEqual({});
    expect(parseWuMeta('')).toEqual({});
  });

  it('坏 JSON → {}（静默吞错，与原各拷贝一致）', () => {
    expect(parseWuMeta('{oops')).toEqual({});
    expect(parseWuMeta('not json')).toEqual({});
  });

  it('泛型形态：调用方按消费字段断言', () => {
    interface WuMeta { title?: string; waitingForInput?: boolean }
    const meta = parseWuMeta<WuMeta>('{"title":"t","waitingForInput":true}');
    expect(meta.title).toBe('t');
    expect(meta.waitingForInput).toBe(true);
  });
});
