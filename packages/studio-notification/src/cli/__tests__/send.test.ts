// @ts-nocheck
import { describe, test, expect } from 'vitest';
import { runSend } from '../send';

describe('AC-001: send 命令', () => {
  test('AC-001-1: 正常发送 info 类型通知', async () => {
    const result = await runSend({ to: '1', type: 'info', message: '测试通知' });
    expect(result.output).toContain('Notification sent');
    expect(result.output).toContain('info');
  });

  test('AC-001-2: 正常发送 warning 类型通知', async () => {
    const result = await runSend({ to: '1', type: 'warning', message: '警告通知' });
    expect(result.output).toContain('warning');
  });

  test('AC-001-3: 正常发送 alert 类型通知', async () => {
    const result = await runSend({ to: '1', type: 'alert', message: '紧急通知' });
    expect(result.output).toContain('alert');
  });

  test('AC-001-4: json 格式输出', async () => {
    const result = await runSend({ to: '1', type: 'info', message: '测试', format: 'json' });
    const data = JSON.parse(result.output);
    expect(data.userId).toBe('1');
    expect(data.type).toBe('info');
  });

  test('AC-001-5: 空消息返回错误', async () => {
    const result = await runSend({ to: '1', type: 'info', message: '' });
    expect(result.error).toContain('不能为空');
  });

  test('AC-001-6: 无效类型返回错误', async () => {
    const result = await runSend({ to: '1', type: 'invalid' as any, message: '测试' });
    expect(result.error).toContain('无效类型');
  });
});