/**
 * 输出格式化器
 *
 * 支持：
 * - table: 表格格式（ASCII）
 * - json: JSON 格式
 * - csv: CSV 格式
 */
const DEFAULT_FORMAT = 'table';
/**
 * 格式化输出
 */
export function formatOutput(data, opts) {
    const format = opts.format || DEFAULT_FORMAT;
    if (data.length === 0) {
        if (format === 'table')
            return '(no data)';
        if (format === 'json')
            return '[]';
        if (format === 'csv')
            return '';
    }
    switch (format) {
        case 'table':
            return formatTable(data, opts.headers);
        case 'json':
            return formatJson(data);
        case 'csv':
            return formatCsv(data, opts.headers, opts.noHeader);
        default:
            throw new Error(`无效格式: ${format}`);
    }
}
/**
 * 表格格式
 */
export function formatTable(data, headers) {
    if (data.length === 0)
        return '(no data)';
    // 获取所有字段
    const allKeys = headers || Object.keys(data[0]);
    const rows = [];
    // 表头
    rows.push(allKeys);
    // 数据行
    for (const item of data) {
        const row = allKeys.map(key => String(item[key] ?? ''));
        rows.push(row);
    }
    // 计算列宽
    const widths = allKeys.map((key, i) => {
        return Math.max(...rows.map(row => row[i].length));
    });
    // 构建表格
    const lines = [];
    // 表头行
    const headerLine = rows[0].map((cell, i) => cell.padEnd(widths[i])).join(' | ');
    lines.push(headerLine);
    // 分隔线
    const separatorLine = widths.map(w => '-'.repeat(w)).join('-+-');
    lines.push(separatorLine);
    // 数据行
    for (let i = 1; i < rows.length; i++) {
        const dataLine = rows[i].map((cell, j) => cell.padEnd(widths[j])).join(' | ');
        lines.push(dataLine);
    }
    return lines.join('\n');
}
/**
 * JSON 格式
 */
export function formatJson(data) {
    return JSON.stringify(data, null, 2);
}
/**
 * CSV 格式
 */
export function formatCsv(data, headers, noHeader) {
    if (data.length === 0)
        return '';
    // 获取所有字段
    const allKeys = headers || Object.keys(data[0]);
    const lines = [];
    // 表头
    if (!noHeader) {
        lines.push(allKeys.join(','));
    }
    // 数据行
    for (const item of data) {
        const row = allKeys.map(key => {
            const value = String(item[key] ?? '');
            // 特殊字符处理
            if (value.includes(',') || value.includes('"')) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        });
        lines.push(row.join(','));
    }
    return lines.join('\n');
}
//# sourceMappingURL=formatter.js.map