/**
 * port-probe — studio run web 端口探测与动态顺延（#571）
 *
 * 冻结语义（docs/architecture/data-directory-contract.md §7）：
 * - 默认 3001，占用则顺次探测 +1…（上限 +100）；顺延结果由调用方标明；
 * - 显式指定（--port / PORT）占用即拒启——显式意图不被顺延覆盖；
 * - 顺延耗尽报错拒启。
 *
 * 探测用 node net 模块（跨平台），不走 lsof（Linux-only，契约 §9 冲突 7）。
 */

import net from 'node:net';

export const DEFAULT_PORT = 3001;
export const MAX_PORT_OFFSET = 100;

export interface ResolvePortOptions {
  host: string;
  /** 显式指定端口（--port / PORT）：占用即拒启 */
  explicitPort?: number;
  /** 缺省首选端口（默认 3001） */
  preferred?: number;
  /** 顺延上限（默认 +100） */
  maxOffset?: number;
}

export interface ResolvedPort {
  port: number;
  /** 发生顺延时为原首选端口，未顺延为 null */
  shiftedFrom: number | null;
}

/** 尝试在 host:port 监听以探测可用性（跨平台，占用/权限错误一律视为不可用） */
export function probePortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

export async function resolvePort(opts: ResolvePortOptions): Promise<ResolvedPort> {
  const host = opts.host;

  if (opts.explicitPort !== undefined) {
    const port = opts.explicitPort;
    if (await probePortFree(port, host)) return { port, shiftedFrom: null };
    throw new Error(
      `Port ${port} was explicitly requested (--port / PORT) but is already in use. `
      + 'Explicit intent is never overridden by fallback — free the port or pick another.',
    );
  }

  const preferred = opts.preferred ?? DEFAULT_PORT;
  const maxOffset = opts.maxOffset ?? MAX_PORT_OFFSET;
  for (let offset = 0; offset <= maxOffset; offset++) {
    const port = preferred + offset;
    if (await probePortFree(port, host)) {
      return { port, shiftedFrom: offset === 0 ? null : preferred };
    }
  }
  throw new Error(
    `No free port in ${preferred}..${preferred + maxOffset} (fallback exhausted). `
    + 'Free a port or pass --port to choose one explicitly.',
  );
}

/** 显式端口来源合一：--port flag 优先，其次 PORT env；皆无 → undefined（动态顺延） */
export function explicitPortFromEnv(flagPort: number | undefined, env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (flagPort !== undefined) return flagPort;
  const raw = env.PORT;
  if (raw === undefined || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got: ${raw}`);
  }
  return port;
}

/** 解析 --port <n> flag：返回端口与摘除 flag 后的参数；缺值/非数字即抛错 */
export function parsePortFlag(args: string[]): { port?: number; rest: string[] } {
  const idx = args.indexOf('--port');
  if (idx === -1) return { port: undefined, rest: args };
  const raw = args[idx + 1];
  if (raw === undefined) throw new Error('--port requires a value (e.g. --port 3001)');
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be an integer between 1 and 65535, got: ${raw}`);
  }
  return { port, rest: args.filter((_, i) => i !== idx && i !== idx + 1) };
}
