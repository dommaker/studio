/**
 * session-mining/jsonl.ts readJsonl 测试（随 ADR-0019 自 harness 迁移后补直测）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsonl } from '../jsonl.js';

describe('readJsonl', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jsonl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skip 策略：坏行跳过并计数，合法行照常解析', () => {
    const p = path.join(dir, 'a.jsonl');
    fs.writeFileSync(p, '{"a":1}\n{"broken\n\n{"a":2}\n', 'utf-8');

    const { records, skippedLines } = readJsonl<{ a: number }>(p, 'skip');
    expect(records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(skippedLines).toBe(1);
  });

  it('throw 策略：坏行直接上抛', () => {
    const p = path.join(dir, 'b.jsonl');
    fs.writeFileSync(p, '{"a":1}\n{"broken\n', 'utf-8');

    expect(() => readJsonl(p, 'throw')).toThrow();
  });

  it('缺文件返回空结果，不抛', () => {
    expect(readJsonl(path.join(dir, 'missing.jsonl'), 'skip'))
      .toEqual({ records: [], skippedLines: 0 });
  });
});
