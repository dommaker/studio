/**
 * session-mining/text.ts 纯函数测试（随 ADR-0019 自 harness 迁移后补直测）
 */

import { describe, it, expect } from 'vitest';
import {
  tokenize,
  jaccardSimilarity,
  jaccardChinese,
  stripCodeBlocks,
  isPunctuation,
  hasSemanticContent,
  isCodeNoise,
  STOP_WORDS,
} from '../text.js';

describe('tokenize', () => {
  it('中文产出 bigram/trigram，短序列保留整体', () => {
    const tokens = tokenize('数据库');
    expect(tokens).toContain('数据');
    expect(tokens).toContain('据库');
    expect(tokens).toContain('数据库');
  });

  it('拉丁/数字/路径字符作为整体 token', () => {
    expect(tokenize('see src/cli/mining.ts ok')).toContain('src/cli/mining.ts');
  });

  it('单字符 token 丢弃', () => {
    expect(tokenize('a b')).toEqual([]);
  });
});

describe('jaccardSimilarity / jaccardChinese', () => {
  it('完全相同文本相似度为 1', () => {
    expect(jaccardSimilarity('数据库迁移', '数据库迁移')).toBe(1);
    expect(jaccardChinese('数据库迁移', '数据库迁移')).toBe(1);
  });

  it('无交集为 0；空输入为 0', () => {
    expect(jaccardChinese('数据库', '迁移方案')).toBe(0);
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardChinese('abc', 'def')).toBe(0); // 无汉字 → 0
  });
});

describe('stripCodeBlocks', () => {
  it('剥离代码块与行内代码', () => {
    expect(stripCodeBlocks('说明 ```const a=1``` 和 `x=2` 完')).not.toContain('const');
  });
});

describe('isPunctuation / hasSemanticContent / isCodeNoise', () => {
  it('纯标点判定', () => {
    expect(isPunctuation('，。！')).toBe(true);
    expect(isPunctuation('内容')).toBe(false);
  });

  it('语义内容：汉字或 ≥7 字符合法英文标识词', () => {
    expect(hasSemanticContent('数据库迁移')).toBe(true);
    expect(hasSemanticContent('migrate')).toBe(true);
    expect(hasSemanticContent('ab')).toBe(false);
  });

  it('代码噪声：短拉丁片段与 JSON 字段名碎片', () => {
    expect(isCodeNoise('role')).toBe(true);
    expect(isCodeNoise('abcdef')).toBe(true);
    expect(isCodeNoise('数据库迁移')).toBe(false);
  });
});

describe('STOP_WORDS', () => {
  it('含中英停用词', () => {
    expect(STOP_WORDS.has('的')).toBe(true);
    expect(STOP_WORDS.has('the')).toBe(true);
  });
});
