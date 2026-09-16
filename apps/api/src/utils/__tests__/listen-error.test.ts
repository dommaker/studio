/**
 * listen-error.ts 单元测试（#573 端口双口径收口）。
 *
 * 冻结语义（docs/architecture/data-directory-contract.md §7 / 摸底冲突 4）：
 * 启动前端口已由 port-probe 单口径解析（默认动态顺延 / 显式占用即拒启），
 * listen 时再撞 EADDRINUSE = 与启动前探测竞态——报错拒启，删除 3s 无限重试。
 */
import { describe, it, expect, vi } from 'vitest';
import { handleServerListenError } from '../listen-error.js';

function makeDeps() {
  const errors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const exit = vi.fn();
  const logger = { error: (msg: string, meta?: Record<string, unknown>) => { errors.push({ msg, meta }); } };
  return { errors, exit, logger };
}

describe('handleServerListenError', () => {
  it('EADDRINUSE → 报错拒启（exit 1），不无限重试', () => {
    const { errors, exit, logger } = makeDeps();
    handleServerListenError(
      { code: 'EADDRINUSE', message: 'listen EADDRINUSE: address in use' },
      { port: 3001, host: '127.0.0.1', logger, exit },
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('3001');
    expect(errors[0].msg).toMatch(/refus|拒启/i);
  });

  it('非 EADDRINUSE → 只记日志，不拒启', () => {
    const { errors, exit, logger } = makeDeps();
    handleServerListenError(
      { code: 'EACCES', message: 'permission denied' },
      { port: 80, host: '127.0.0.1', logger, exit },
    );
    expect(exit).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].meta).toMatchObject({ code: 'EACCES', port: 80 });
  });
});
