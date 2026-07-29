/**
 * Shared Logger - 统一日志接口
 *
 * 提供简单的日志接口，各 studio 包统一使用
 * 后续可升级为 pino/winston
 */
/**
 * 默认 logger 实现（基于 console）
 */
export const logger = {
    info(message, data) {
        if (data) {
            console.log(`[INFO] ${message}`, JSON.stringify(data));
        }
        else {
            console.log(`[INFO] ${message}`);
        }
    },
    error(message, data) {
        if (data) {
            console.error(`[ERROR] ${message}`, JSON.stringify(data));
        }
        else {
            console.error(`[ERROR] ${message}`);
        }
    },
    debug(message, data) {
        if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
            if (data) {
                console.debug(`[DEBUG] ${message}`, JSON.stringify(data));
            }
            else {
                console.debug(`[DEBUG] ${message}`);
            }
        }
    },
    warn(message, data) {
        if (data) {
            console.warn(`[WARN] ${message}`, JSON.stringify(data));
        }
        else {
            console.warn(`[WARN] ${message}`);
        }
    },
};
/**
 * 创建带上下文的 logger
 */
export function createLogger(context) {
    return {
        info(message, data) {
            logger.info(`[${context}] ${message}`, data);
        },
        error(message, data) {
            logger.error(`[${context}] ${message}`, data);
        },
        debug(message, data) {
            logger.debug(`[${context}] ${message}`, data);
        },
        warn(message, data) {
            logger.warn(`[${context}] ${message}`, data);
        },
    };
}
//# sourceMappingURL=logger.js.map