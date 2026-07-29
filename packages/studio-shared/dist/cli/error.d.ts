/**
 * 错误处理
 *
 * 统一的错误输出格式
 */
export interface CliError {
    code: string;
    message: string;
    details?: any;
}
export declare const ERROR_CODES: {
    UNKNOWN_PARAM: string;
    MISSING_VALUE: string;
    INVALID_JSON: string;
    INVALID_FORMAT: string;
    COMMAND_NOT_FOUND: string;
    CONFIG_PARSE_ERROR: string;
};
/**
 * 格式化错误输出
 */
export declare function formatError(error: Error | CliError): string;
/**
 * 创建 CLI 错误
 */
export declare function createCliError(code: string, message: string, details?: any): CliError;
//# sourceMappingURL=error.d.ts.map