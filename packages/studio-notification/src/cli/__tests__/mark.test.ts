// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runMark } from '../mark';

describe('AC-003: mark 命令', () => {
  test('AC-003-1: 正常标记已读', async () => {
    const result = await runMark({ notification: '1' });
    expect(result.output).toContain('marked as read');
  });

  test('AC-003-2: 已读通知返回提示', async () => {
    const result = await runMark({ notification: 'already-read' });
    expect(result.output).toContain('already read');
  });

  test('AC-003-3: 通知不存在返回错误', async () => {
    const result = await runMark({ notification: 'nonexistent' });
    expect(result.error).toContain('不存在');
  });

  test('AC-003-4: json 格式输出', async () => {
    // 使用一个新的通知 ID 避免状态冲突
    const result = await runMark({ notification: '2', format: 'json' });
    // JSON.stringify 会输出多行格式
    expect(result.output).toContain('notificationId');
    expect(result.output).toContain('"2"');
    expect(result.output).toContain('status');
    expect(result.output).toContain('"read"');
  });

  test('AC-003-5: 批量标记 (--all)', async () => {
    const result = await runMark({ all: true });
    // 验证批量标记输出
    expect(result.output).toMatch(/All \d+ notifications marked as read/i);
  });
});