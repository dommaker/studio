/** 覆盖目录解析（每次调用现算，支持测试中途改 env）。 */
export declare function resolvePromptOverridesDir(): string;
/**
 * 读取模板覆盖文本。不存在/读取失败 → null（回退默认模板）。
 * templateId 净化：拒绝路径分隔符，防目录穿越。
 */
export declare function readPromptOverride(templateId: string): string | null;
/**
 * 用覆盖文件渲染模板：无覆盖 → 原样返回 fallback（默认行为零变化）。
 * 有覆盖 → 替换 {content}/{count} 占位符；覆盖文本无 {content} 且提供了 content
 * 时，动态内容追加到覆盖文本之后（保证动态条目不丢）。
 */
export declare function renderWithOverride(templateId: string, fallback: string, vars?: {
    content?: string;
    count?: number;
}): string;
//# sourceMappingURL=prompt-overrides.d.ts.map