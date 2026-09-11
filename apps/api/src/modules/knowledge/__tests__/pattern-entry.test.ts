/**
 * pattern-entry 单测（2026-09-10 /api/v1/knowledge/search 500 根因修复配套）。
 *
 * 覆盖：
 * - parsePatternContent：合法 JSON object / 空正文 / 非 JSON / 非 object JSON；
 * - listInteractionPatterns：type 口径判别（tag 'pattern' 的 guideline 不混入），
 *   extraTags 透传；
 * - PatternMiner.getActivePatterns 混入 markdown guideline 与损坏 pattern 条目
 *   时不抛错且只返回正常条目（pattern-miner 原 5 处裸 JSON.parse 的防回归）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parsePatternContent, listInteractionPatterns } from '../pattern-entry.js';

describe('parsePatternContent', () => {
  it('合法 JSON object → 解析结果', () => {
    expect(parsePatternContent('{"confidence":0.9}')).toEqual({ confidence: 0.9 });
  });

  it('空正文 → {}（兼容 content || \'{}\' 旧口径）', () => {
    expect(parsePatternContent('')).toEqual({});
    expect(parsePatternContent(undefined)).toEqual({});
    expect(parsePatternContent(null)).toEqual({});
  });

  it('非 JSON（markdown 正文）→ null', () => {
    expect(parsePatternContent('# 标题\n\nCommit: 1b2c3d')).toBeNull();
  });

  it('JSON 非 object（数组/标量）→ null', () => {
    expect(parsePatternContent('[1,2]')).toBeNull();
    expect(parsePatternContent('"str"')).toBeNull();
    expect(parsePatternContent('5')).toBeNull();
  });
});

describe('listInteractionPatterns + PatternMiner 混合数据防回归', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-entry-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('type 口径判别 + getActivePatterns 不抛错', async () => {
    const { sharedStore } = await import('../knowledge-singletons.js');
    const ts = new Date().toISOString();
    const base = {
      layer: 'project', created: ts, lastReferenced: ts,
      contributors: [], projects: [], applicablePhases: [],
      sourceReferences: [], referencedBy: [], executionResults: [],
    } as const;
    sharedStore.save({
      ...base, id: 'pat-pe-good', type: 'pattern', title: '序列: A → B',
      content: JSON.stringify({ category: 'tool_usage', confidence: 0.9, frequency: 7 }),
      maturity: 'active', tags: ['pattern', 'active', 'tool_usage'], consumptionMode: 'signal', origin: 'system',
    } as any);
    sharedStore.save({
      ...base, id: 'gui-pe-md', type: 'guideline', title: 'markdown 规范',
      content: '# 规范\n\nmarkdown 正文', maturity: 'active',
      tags: ['pattern', 'session-summary'], consumptionMode: 'reference', origin: 'agent',
    } as any);
    sharedStore.save({
      ...base, id: 'pat-pe-corrupt', type: 'pattern', title: '损坏条目',
      content: 'not-json', maturity: 'active',
      tags: ['pattern', 'active'], consumptionMode: 'signal', origin: 'system',
    } as any);

    // type 判别：guideline 不混入（哪怕带 'pattern' tag）
    const all = listInteractionPatterns(sharedStore);
    expect(all.map(e => e.id).sort()).toEqual(['pat-pe-corrupt', 'pat-pe-good']);

    // extraTags 透传
    const activeToolUsage = listInteractionPatterns(sharedStore, ['active', 'tool_usage']);
    expect(activeToolUsage.map(e => e.id).sort()).toEqual(['pat-pe-corrupt', 'pat-pe-good']);

    // PatternMiner.getActivePatterns：损坏条目跳过，不抛错
    const { PatternMiner } = await import('../pattern-miner.js');
    const miner = new PatternMiner();
    const active = await miner.getActivePatterns();
    expect(active.map(p => p.id)).toEqual(['pat-pe-good']);
    expect(active[0].name).toBe('序列: A → B');
  });
});
