/**
 * Claude Code transcript（.jsonl）读取
 * （自 harness src/cli/session-mining/transcript.ts 迁入，ADR-0019；原工单 19-C）
 *
 * update-user-model 与 analyze-sessions 共用同一份解析逻辑。
 */

import * as fs from 'fs';
import * as path from 'path';
import { readJsonl } from './jsonl.js';

export interface MinedTurn {
  role: string;
  content: string;
}

export interface MinedSession {
  /** 会话 ID（文件名去掉 .jsonl，截断至 40 字符） */
  id: string;
  /** 文件修改日期（YYYY-MM-DD） */
  date: string;
  /** 修改时间戳（毫秒） */
  mtimeMs: number;
  turns: MinedTurn[];
  /** 出现过的工具调用名（去重，保持出现顺序） */
  toolCalls: string[];
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}

/**
 * 扫描目录下的 .jsonl transcript 文件
 *
 * 不可读/损坏的行静默跳过。
 */
export interface TranscriptFilter {
  /** 只读 mtimeMs >= since 的文件（stat 级过滤，命中即不 parse）；缺省不过滤 */
  since?: number;
  /** 按会话 ID（文件名去 .jsonl、截断 40 字符）排除（文件名级过滤，不 stat 不 parse）；缺省不排除 */
  excludeIds?: string[];
}

export function readTranscriptSessions(dir: string, filter: TranscriptFilter = {}): MinedSession[] {
  const sessions: MinedSession[] = [];
  const exclude = filter.excludeIds && filter.excludeIds.length > 0
    ? new Set(filter.excludeIds)
    : undefined;

  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return sessions;
  }

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.replace('.jsonl', '').slice(0, 40);
    if (exclude?.has(id)) continue;
    const filePath = path.join(dir, file);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (filter.since !== undefined && stat.mtimeMs < filter.since) continue;

    const turns: MinedTurn[] = [];
    const toolCalls: string[] = [];

    let records: Record<string, any>[];
    try {
      // 损坏行静默跳过（坏行策略 skip）；外层 catch 兜文件不可读，跳过该文件。
      // 计数去向：豁免——读的是外部 Claude Code transcript（非本系统写入面）。
      // 影响方向如实：坏行使该会话少几条 turn，而 analyze-sessions 的候选按次数阈值筛
      // （frequency>=4 / 跨会话>=2 / confidence=len/10）→ 只会少出候选，不会造出候选，且候选须人审
      records = readJsonl<Record<string, any>>(filePath, 'skip').records;
    } catch {
      continue;
    }

    for (const entry of records) {
      try {
        const msg = entry.message;
        if (msg?.role && (msg.content || entry.type === 'user')) {
          turns.push({ role: msg.role, content: extractText(msg.content) });
        }
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use' && block.name) {
              toolCalls.push(block.name);
            }
          }
        }
      } catch {
        // 单条记录提取异常跳过（parse 已由 readJsonl skip，此处兜提取）
      }
    }

    if (turns.length > 0) {
      sessions.push({
        id,
        date: stat.mtime.toISOString().slice(0, 10),
        mtimeMs: stat.mtimeMs,
        turns,
        toolCalls: [...new Set(toolCalls)],
      });
    }
  }

  return sessions;
}
