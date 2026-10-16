/**
 * Shared Logger（pino 正本，Node-only）
 *
 * 经 '@dommaker/studio-shared/node' 出口导出；根入口的 './logger'（console 版）
 * 保留给 web 可达模块（file-store / studio-events 等）内部使用，勿在此出口之外引 pino。
 *
 * 类型为 Logger & pino.Logger 交集：console 版调用形态（logger.info(msg, meta)，
 * 全仓 ~160 处消费方）与 pino 结构化原形（logger.info(obj, msg)，core/http.ts 等）
 * 均合法；运行时是裸 pino 实例，零包装。
 */
import pino from 'pino';
import type { Logger } from './logger';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

export const logger: Logger & pino.Logger = pinoLogger as Logger & pino.Logger;
