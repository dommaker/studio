/**
 * Shared Logger - 统一日志接口
 * 
 * 提供简单的日志接口，各 studio 包统一使用
 * 后续可升级为 pino/winston
 */

export interface Logger {
  info(message: string, data?: Record<string, any>): void;
  error(message: string, data?: Record<string, any>): void;
  debug(message: string, data?: Record<string, any>): void;
  warn(message: string, data?: Record<string, any>): void;
}

/**
 * 默认 logger 实现（基于 console）
 */
export const logger: Logger = {
  info(message: string, data?: Record<string, any>) {
    if (data) {
      console.log(`[INFO] ${message}`, JSON.stringify(data));
    } else {
      console.log(`[INFO] ${message}`);
    }
  },

  error(message: string, data?: Record<string, any>) {
    if (data) {
      console.error(`[ERROR] ${message}`, JSON.stringify(data));
    } else {
      console.error(`[ERROR] ${message}`);
    }
  },

  debug(message: string, data?: Record<string, any>) {
    if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
      if (data) {
        console.debug(`[DEBUG] ${message}`, JSON.stringify(data));
      } else {
        console.debug(`[DEBUG] ${message}`);
      }
    }
  },

  warn(message: string, data?: Record<string, any>) {
    if (data) {
      console.warn(`[WARN] ${message}`, JSON.stringify(data));
    } else {
      console.warn(`[WARN] ${message}`);
    }
  },
};