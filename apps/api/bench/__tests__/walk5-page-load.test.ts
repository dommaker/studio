/**
 * #510 走查⑤ bench：纯函数/合成器测试（statOf 统计 + synthChannel 数据合成）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statOf, synthChannel } from '../walk5-page-load.js';

describe('statOf', () => {
  it('单调序列：p50/p95/max 与均值正确', () => {
    const s = statOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.n).toBe(10);
    expect(s.mean).toBeCloseTo(5.5);
    expect(s.p50).toBe(6); // floor(0.5*10)=5 → 升序第 6 个元素
    expect(s.p95).toBe(10); // floor(0.95*10)=9 → 末元素
    expect(s.max).toBe(10);
  });

  it('单元素：各分位恒等', () => {
    const s = statOf([42]);
    expect(s).toEqual({ n: 1, mean: 42, p50: 42, p95: 42, max: 42 });
  });
});

describe('synthChannel', () => {
  it('生成热文件 + 冷月文件，行数与命名符合 FileStore 布局', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'walk5-test-'));
    try {
      synthChannel(base, 'ch', 3, 2, 4);
      const dir = path.join(base, 'channels', 'ch');
      const hot = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf-8').trim().split('\n');
      expect(hot).toHaveLength(3);
      const row = JSON.parse(hot[0]);
      expect(row.channelId).toBe('ch');
      expect(row.id).toBe('m-ch-0');
      const months = fs.readdirSync(path.join(dir, 'archive')).sort();
      expect(months).toEqual(['messages-2024-01.jsonl', 'messages-2024-02.jsonl']);
      const cold = fs.readFileSync(path.join(dir, 'archive', months[0]), 'utf-8').trim().split('\n');
      expect(cold).toHaveLength(4);
      // 冷行 id 接在热行之后（深冷页锚点定位依赖此约定）
      expect(JSON.parse(cold[0]).id).toBe('m-ch-3');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('coldMonths=0 时不建 archive 目录', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'walk5-test-'));
    try {
      synthChannel(base, 'ch', 2, 0, 0);
      expect(fs.existsSync(path.join(base, 'channels', 'ch', 'archive'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
