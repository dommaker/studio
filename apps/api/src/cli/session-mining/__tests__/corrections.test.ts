/**
 * session-mining/corrections.ts 纠正模式表测试（随 ADR-0019 自 harness 迁移后补直测）
 */

import { describe, it, expect } from 'vitest';
import {
  CORRECTION_PATTERNS,
  extractCorrectionMatches,
  cleanCorrectionConcept,
} from '../corrections.js';

describe('extractCorrectionMatches', () => {
  it('命中「你又/我不是说/怎么又」类纠正语句', () => {
    expect(extractCorrectionMatches('你又忘了先跑测试了').length).toBeGreaterThan(0);
    expect(extractCorrectionMatches('我不是说过了要用中文吗').length).toBeGreaterThan(0);
    expect(extractCorrectionMatches('怎么又在硬编码路径了').length).toBeGreaterThan(0);
  });

  it('普通陈述不命中', () => {
    expect(extractCorrectionMatches('数据库迁移方案需要执行')).toEqual([]);
  });

  it('模式表可复用：连续调用不受 lastIndex 残留影响', () => {
    const text = '你又忘了先跑测试了';
    expect(extractCorrectionMatches(text)).toEqual(extractCorrectionMatches(text));
  });
});

describe('cleanCorrectionConcept', () => {
  it('剥离纠正前缀与标点', () => {
    // 前缀正则止于「犯|忘|没|不」，尾部「了」保留（与 harness 原件同一张表）
    expect(cleanCorrectionConcept('你又忘了先跑测试了')).toBe('了先跑测试了');
    expect(cleanCorrectionConcept('我不是说过了，要用中文吗')).toBe('了要用中文吗');
    expect(cleanCorrectionConcept('怎么又在硬编码路径了')).toBe('硬编码路径了');
  });
});

describe('CORRECTION_PATTERNS', () => {
  it('模式表非空且均为全局 RegExp', () => {
    expect(CORRECTION_PATTERNS.length).toBeGreaterThan(0);
    for (const re of CORRECTION_PATTERNS) {
      expect(re.global).toBe(true);
    }
  });
});
