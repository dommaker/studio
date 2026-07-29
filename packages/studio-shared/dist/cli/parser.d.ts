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
    allowShort?: boolean;
    allowJson?: boolean;
    allowKeyValue?: boolean;
    envPrefix?: string;
    knownParams?: string[];
}
export interface ParsedArgs {
    command: string;
    options: Record<string, any>;
    positional: string[];
}
/**
 * 解析命令行参数
 */
export declare function parseArgs(argv: string[], opts?: ParseOptions): ParsedArgs;
/**
 * 解析 JSON 参数
 */
export declare function parseJsonArg(value: string): any;
/**
 * 解析 key=value 参数
 */
export declare function parseKeyValueArg(value: string): Record<string, string>;
//# sourceMappingURL=parser.d.ts.map