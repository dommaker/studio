/**
 * 输出格式化器
 *
 * 支持：
 * - table: 表格格式（ASCII）
 * - json: JSON 格式
 * - csv: CSV 格式
 */
export type Format = 'table' | 'json' | 'csv';
export interface FormatOptions {
    format: Format;
    headers?: string[];
    noHeader?: boolean;
}
/**
 * 格式化输出
 */
export declare function formatOutput(data: any[], opts: FormatOptions): string;
/**
 * 表格格式
 */
export declare function formatTable(data: any[], headers?: string[]): string;
/**
 * JSON 格式
 */
export declare function formatJson(data: any[]): string;
/**
 * CSV 格式
 */
export declare function formatCsv(data: any[], headers?: string[], noHeader?: boolean): string;
//# sourceMappingURL=formatter.d.ts.map