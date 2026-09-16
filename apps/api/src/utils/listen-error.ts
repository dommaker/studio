/**
 * listen-error — server.listen 错误处理（#573 端口双口径收口）
 *
 * 冻结语义（docs/architecture/data-directory-contract.md §7 / 摸底冲突 4）：
 * 启动前端口已由 port-probe 单口径解析（默认 3001 动态顺延上限 +100；
 * 显式 --port/PORT 占用即拒启）。listen 时再撞 EADDRINUSE = 与启动前探测
 * 竞态——报错拒启；旧 index.ts 的 3s 无限重试已删除，全系统只此一套口径。
 */

export interface ListenErrorLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ListenErrorOptions {
  port: number | string;
  host: string;
  logger: ListenErrorLogger;
  /** 默认 process.exit；测试注入 spy */
  exit?: (code: number) => void;
}

export function handleServerListenError(
  err: { code?: string; message?: string } | undefined,
  opts: ListenErrorOptions,
): void {
  if (err?.code === 'EADDRINUSE') {
    opts.logger.error(
      `Port ${opts.port} on ${opts.host} became unavailable at listen time — refusing to start `
      + '(拒启：端口在启动前探测后又被占用；无自动重试，端口口径见 cli/port-probe)',
      { code: err.code, port: opts.port, host: opts.host },
    );
    (opts.exit ?? process.exit)(1);
    return;
  }
  opts.logger.error('Server listen error', { code: err?.code, message: err?.message, port: opts.port });
}
