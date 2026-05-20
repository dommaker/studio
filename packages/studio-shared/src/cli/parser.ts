/**
 * 参数解析器
 * 
 * 支持：
 * - 短参数：-c 1
 * - 长参数：--company 1
 * - key=value：--company=1
 * - JSON：--format={"type":"table"}
 */

export interface ParseOptions {
  allowShort?: boolean;     // 允许短参数 -c
  allowJson?: boolean;      // 允许 JSON 字符串
  allowKeyValue?: boolean;  // 允许 key=value
  envPrefix?: string;       // 环境变量前缀
  knownParams?: string[];   // 已知参数列表（用于校验）
}

export interface ParsedArgs {
  command: string;          // 命令名
  options: Record<string, any>;  // 参数
  positional: string[];     // 位置参数
}

const DEFAULT_OPTIONS: ParseOptions = {
  allowShort: true,
  allowJson: true,
  allowKeyValue: true,
  envPrefix: 'STUDIO_',
  knownParams: ['company', 'c', 'format', 'f', 'user', 'output', 'from', 'to', 'limit'],
};

/**
 * 解析命令行参数
 */
export function parseArgs(argv: string[], opts?: ParseOptions): ParsedArgs {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const result: ParsedArgs = {
    command: '',
    options: {},
    positional: [],
  };

  if (argv.length === 0) {
    return result;
  }

  // 第一个非参数作为命令
  let commandFound = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!commandFound && !arg.startsWith('-')) {
      result.command = arg;
      commandFound = true;
      continue;
    }

    if (!commandFound && arg.startsWith('-')) {
      // 参数在命令之前，跳过命令识别
      commandFound = true;
      result.command = '';
    }

    // 短参数 -c
    if (options.allowShort && arg.startsWith('-') && !arg.startsWith('--') && arg.length === 2) {
      const key = arg.slice(1);
      const nextArg = argv[i + 1];

      if (!nextArg) {
        throw new Error(`参数值缺失: ${arg}`);
      }

      // 空字符串是有效值，只有下一个是参数时才算缺失
      if (nextArg.startsWith('-') && nextArg !== '-') {
        throw new Error(`参数值缺失: ${arg}`);
      }

      validateParam(key, options);
      result.options[key] = nextArg;
      i++; // 跳过值
      continue;
    }

    // 长参数 --company 1 或 --company=1
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      
      if (equalIndex !== -1) {
        // key=value 格式
        const key = arg.slice(2, equalIndex);
        const value = arg.slice(equalIndex + 1);

        validateParam(key, options);

        if (options.allowJson && value.startsWith('{')) {
          result.options[key] = parseJsonArg(value);
        } else {
          result.options[key] = value;
        }
      } else {
        // --company 1 格式
        const key = arg.slice(2);
        const nextArg = argv[i + 1];

        // 只有当下一个参数不存在时才算缺失（空字符串是有效值）
        if (i + 1 >= argv.length) {
          throw new Error(`参数值缺失: ${arg}`);
        }

        // 下一个是新参数时才算缺失（空字符串不是参数）
        if (nextArg.startsWith('--') || (nextArg.length === 2 && nextArg[0] === '-' && nextArg[1] !== '-')) {
          throw new Error(`参数值缺失: ${arg}`);
        }

        validateParam(key, options);

        if (options.allowJson && nextArg.startsWith('{')) {
          result.options[key] = parseJsonArg(nextArg);
          i++;
        } else {
          result.options[key] = nextArg;
          i++;
        }
      }
      continue;
    }

    // 位置参数
    result.positional.push(arg);
  }

  return result;
}

/**
 * 验证参数是否已知
 */
function validateParam(key: string, options: ParseOptions): void {
  if (options.knownParams && options.knownParams.length > 0) {
    if (!options.knownParams.includes(key)) {
      throw new Error(`未知参数: --${key}`);
    }
  }
}

/**
 * 解析 JSON 参数
 */
export function parseJsonArg(value: string): any {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`JSON 格式错误: ${value}`);
  }
}

/**
 * 解析 key=value 参数
 */
export function parseKeyValueArg(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  // 支持逗号分隔的多个 key=value
  const pairs = value.split(',');
  
  for (const pair of pairs) {
    const equalIndex = pair.indexOf('=');
    if (equalIndex !== -1) {
      const key = pair.slice(0, equalIndex);
      const val = pair.slice(equalIndex + 1);
      result[key] = val;
    }
  }
  
  return result;
}