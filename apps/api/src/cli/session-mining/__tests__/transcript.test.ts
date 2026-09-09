/**
 * readTranscriptSessions 坏行/null 记录容错测试（harness#82，随 ADR-0019 迁移）
 *
 * transcript 行可 parse 但值为 null（或提取异常）时，
 * 与原逐行 catch 实现一致：该条跳过，不影响其余记录。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscriptSessions } from '../transcript.js';

describe('readTranscriptSessions 坏行容错（harness#82）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transcript-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('null 行与坏行只丢该行，合法 turn 照常提取', () => {
    const lines = [
      JSON.stringify({ message: { role: 'user', content: 'hello' } }),
      'null', // parse 合法但值为 null，原实现经逐行 catch 跳过
      '{"broken',
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ];
    fs.writeFileSync(path.join(dir, 'session-a.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const sessions = readTranscriptSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].turns.map(t => t.role)).toEqual(['user', 'assistant']);
    expect(sessions[0].turns[1].content).toBe('hi');
  });

  it('目录不可读返回空数组', () => {
    expect(readTranscriptSessions(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('readTranscriptSessions 过滤（harness#112）', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-transcript-filter-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeSession(name: string, text: string, mtime?: Date): void {
    const p = path.join(dir, name);
    fs.writeFileSync(
      p,
      JSON.stringify({ message: { role: 'user', content: text } }) + '\n',
      'utf-8',
    );
    if (mtime) fs.utimesSync(p, mtime, mtime);
  }

  it('excludeIds：命中的会话不进结果（文件名级过滤，不 parse）', () => {
    writeSession('session-a.jsonl', '甲会话内容');
    writeSession('session-b.jsonl', '乙会话内容');

    const sessions = readTranscriptSessions(dir, { excludeIds: ['session-a'] });
    expect(sessions.map(s => s.id)).toEqual(['session-b']);
  });

  it('excludeIds 按截断 40 字符的会话 ID 匹配', () => {
    const longName = 'a'.repeat(50);
    writeSession(`${longName}.jsonl`, '长名会话内容');
    writeSession('session-b.jsonl', '乙会话内容');

    const sessions = readTranscriptSessions(dir, { excludeIds: [longName.slice(0, 40)] });
    expect(sessions.map(s => s.id)).toEqual(['session-b']);
  });

  it('since：mtimeMs 早于窗口的文件不进结果（stat 级过滤，不 parse）', () => {
    writeSession('old.jsonl', '旧会话内容', new Date(Date.now() - 30 * 86_400_000));
    writeSession('recent.jsonl', '新会话内容');

    const since = Date.now() - 7 * 86_400_000;
    const sessions = readTranscriptSessions(dir, { since });
    expect(sessions.map(s => s.id)).toEqual(['recent']);
  });

  it('since 边界含等于：mtimeMs == since 仍计入', () => {
    const t = new Date('2026-08-01T12:00:00.000Z');
    writeSession('edge.jsonl', '边界会话内容', t);

    const sessions = readTranscriptSessions(dir, { since: t.getTime() });
    expect(sessions.map(s => s.id)).toEqual(['edge']);
  });

  it('since 与 excludeIds 可叠加', () => {
    writeSession('old.jsonl', '旧会话内容', new Date(Date.now() - 30 * 86_400_000));
    writeSession('excluded.jsonl', '被排除会话');
    writeSession('kept.jsonl', '保留会话内容');

    const sessions = readTranscriptSessions(dir, {
      since: Date.now() - 7 * 86_400_000,
      excludeIds: ['excluded'],
    });
    expect(sessions.map(s => s.id)).toEqual(['kept']);
  });

  it('无 filter：全量读取（向后兼容）', () => {
    writeSession('a.jsonl', '甲会话内容', new Date(Date.now() - 30 * 86_400_000));
    writeSession('b.jsonl', '乙会话内容');

    const sessions = readTranscriptSessions(dir);
    expect(sessions).toHaveLength(2);
  });
});
