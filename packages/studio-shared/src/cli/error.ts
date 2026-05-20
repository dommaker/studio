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

export const ERROR_CODES = {
  UNKNOWN_PARAM: 'UNKNOWN_PARAM',
  MISSING_VALUE: 'MISSING_VALUE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_FORMAT: 'INVALID_FORMAT',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  CONFIG_PARSE_ERROR: 'CONFIG_PARSE_ERROR',
};

/**
 * 格式化错误输出
 */
export function formatError(error: Error | CliError): string {
  if ('code' in error) {
    return `[${error.code}] ${error.message}`;
  }

  // 普通 Error
  const message = error.message;
  
  // 尝试识别错误类型
  if (message.includes('未知参数')) {
    return `[${ERROR_CODES.UNKNOWN_PARAM}] ${message}`;
  }
  if (message.includes('参数值缺失')) {
    return `[${ERROR_CODES.MISSING_VALUE}] ${message}`;
  }
  if (message.includes('JSON 格式错误')) {
    return `[${ERROR_CODES.INVALID_JSON}] ${message}`;
  }
  if (message.includes('无效格式')) {
    return `[${ERROR_CODES.INVALID_FORMAT}] ${message}`;
  }
  if (message.includes('命令不存在')) {
    return `[${ERROR_CODES.COMMAND_NOT_FOUND}] ${message}`;
  }
  if (message.includes('配置文件解析错误')) {
    return `[${ERROR_CODES.CONFIG_PARSE_ERROR}] ${message}`;
  }

  return `[UNKNOWN] ${message}`;
}

/**
 * 创建 CLI 错误
 */
export function createCliError(code: string, message: string, details?: any): CliError {
  return {
    code,
    message,
    details,
  };
}