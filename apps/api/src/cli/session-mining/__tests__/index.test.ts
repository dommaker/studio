/**
 * session-mining/index.ts 导出面测试（随 ADR-0019 自 harness 迁移）
 *
 * 纯 re-export 模块：锁定两个命令依赖的符号全部可达，防迁移漏导。
 */

import { describe, it, expect } from 'vitest';
import * as mining from '../index.js';

describe('session-mining 导出面', () => {
  it('transcript/corrections/text 的公开符号全部导出', () => {
    // transcript
    expect(typeof mining.readTranscriptSessions).toBe('function');
    // corrections
    expect(Array.isArray(mining.CORRECTION_PATTERNS)).toBe(true);
    expect(typeof mining.extractCorrectionMatches).toBe('function');
    expect(typeof mining.cleanCorrectionConcept).toBe('function');
    // text
    expect(mining.STOP_WORDS instanceof Set).toBe(true);
    for (const fn of ['tokenize', 'jaccardSimilarity', 'jaccardChinese', 'stripCodeBlocks',
      'isPunctuation', 'hasSemanticContent', 'isCodeNoise'] as const) {
      expect(typeof mining[fn]).toBe('function');
    }
  });
});
