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
export declare const logger: Logger;
/**
 * 创建带上下文的 logger
 */
export declare function createLogger(context: string): Logger;
//# sourceMappingURL=logger.d.ts.map