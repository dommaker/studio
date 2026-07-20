/**
 * workflow.ts 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖执行/审批域的离线路径（PORT 指向未占用端口）：
 * - studioRun：空需求 → usage + exit(1)；API 不可达 → 连接失败 + exit(1)；
 * - studioApprove：无参数 → usage 块（不发请求、不 exit）；
 * - studioReject：无参数 → usage；未知类型 → Unknown reject type + exit(1)（不发请求）；
 *   合法类型但 API 不可达 → Failed + exit(1)。
 * process.exit mock 为抛错以断言退出码；process.argv 按用例替换并恢复。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { studioApprove, studioReject, studioRun } from '../workflow.js';

let logs: string[];
let errs: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;
let prevArgv: string[];
let prevPort: string | undefined;

beforeEach(() => {
  logs = [];
  errs = [];
  prevArgv = process.argv;
  prevPort = process.env.PORT;
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: any) => {
    throw new Error(`exit:${code}`);
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = prevArgv;
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
});

describe('studioRun', () => {
  it('空需求 → usage + exit(1)', async () => {
    process.argv = ['node', 'studio', 'run', '   '];
    await expect(studioRun()).rejects.toThrow('exit:1');
    expect(errs.join('\n')).toContain('Usage: studio run "requirement description"');
  });

  it('API 不可达 → 连接失败提示 + exit(1)', async () => {
    process.env.PORT = '19131';
    process.argv = ['node', 'studio', 'run', 'add', 'feature'];
    await expect(studioRun()).rejects.toThrow('exit:1');
    const out = errs.join('\n');
    expect(out).toContain('Failed to connect to studio server:');
    expect(out).toContain('Make sure studio is running: studio up');
  });
});

describe('studioApprove', () => {
  it('无参数 → 打印 usage 块，不发请求不 exit', async () => {
    process.argv = ['node', 'studio', 'approve'];
    await studioApprove();
    const out = logs.join('\n');
    expect(out).toContain('studio approve list                      List all pending approvals');
    expect(out).toContain('studio approve req <messageId>');
    expect(out).toContain('studio reject  <type> <messageId>        Reject any pending approval');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('approve list 在 API 不可达时输出 Failed 但不 exit', async () => {
    process.env.PORT = '19131';
    process.argv = ['node', 'studio', 'approve', 'list'];
    await studioApprove();
    expect(logs.join('\n')).toContain('Pending Approvals');
    expect(errs.join('\n')).toContain('Failed:');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('studioReject', () => {
  it('无参数 → usage，不发请求不 exit', async () => {
    process.argv = ['node', 'studio', 'reject'];
    await studioReject();
    const out = logs.join('\n');
    expect(out).toContain('Usage: studio reject <type> <messageId>');
    expect(out).toContain('studio reject knowledge <messageId>');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('未知类型 → Unknown reject type + exit(1)（不发请求）', async () => {
    process.argv = ['node', 'studio', 'reject', 'bogus', 'msg-1'];
    await expect(studioReject()).rejects.toThrow('exit:1');
    expect(errs.join('\n')).toContain('Unknown reject type: bogus');
  });

  it('合法类型但 API 不可达 → Failed + exit(1)', async () => {
    process.env.PORT = '19131';
    process.argv = ['node', 'studio', 'reject', 'knowledge', 'msg-1'];
    await expect(studioReject()).rejects.toThrow('exit:1');
    expect(errs.join('\n')).toContain('Failed:');
  });
});
