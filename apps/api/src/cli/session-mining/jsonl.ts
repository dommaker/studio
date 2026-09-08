/**
 * JSONL 读取（自 harness src/utils/jsonl.ts 迁入最小面，ADR-0019）
 *
 * 只保留 session-mining 消费的部分：显式坏行策略 + 全量读。
 * 坏行指非空但 JSON.parse 失败的行（半写入截断、手工编辑、磁盘满等）。
 */

import * as fs from 'fs';

/**
 * 坏行策略
 *
 * - 'skip'：跳过损坏行，继续解析；skippedLines 计数
 * - 'throw'：损坏行直接上抛
 */
export type JsonlBadLinePolicy = 'skip' | 'throw';

export interface JsonlReadResult<T> {
  records: T[];
  /** 被跳过的坏行数（'throw' 策略下恒为 0） */
  skippedLines: number;
}

/**
 * 读取 JSONL 文件：exists → read → split → parse → filter
 *
 * policy 必填无缺省；缺文件返回空结果，不抛。
 */
export function readJsonl<T>(filePath: string, policy: JsonlBadLinePolicy): JsonlReadResult<T> {
  if (!fs.existsSync(filePath)) return { records: [], skippedLines: 0 };
  const lines = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0);

  const records: T[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch (e) {
      if (policy === 'throw') throw e;
      skippedLines++;
    }
  }
  return { records, skippedLines };
}
