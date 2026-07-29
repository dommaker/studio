/**
 * Spec Markdown 解析器
 *
 * 从 Spec 文件中提取结构化内容，供 agent 上下文加载使用。
 * 提取自 SpecValidatorService，可独立复用。
 *
 * 用法：
 * ```typescript
 * import { parseSpecMarkdown, loadSpecFile } from '@dommaker/studio-shared';
 *
 * // 从文件加载
 * const spec = await loadSpecFile('/path/to/spec.md');
 *
 * // 从内容解析
 * const spec = parseSpecMarkdown(content, 'spec-id');
 * ```
 */
export interface SpecContent {
    metadata: {
        id: string;
        title?: string;
        status?: 'draft' | 'in_progress' | 'completed' | 'deprecated';
        created?: string;
        updated?: string;
    };
    architecture?: {
        dependencies?: string[];
        data_models?: string[];
    };
    api?: {
        endpoints?: ApiEndpoint[];
        schemas?: Record<string, SchemaDefinition>;
    };
    acceptance_criteria?: AcceptanceCriterion[];
}
export interface ApiEndpoint {
    path: string;
    method: string;
    request?: string;
    response?: string;
}
export interface SchemaDefinition {
    type: string;
    properties?: Record<string, unknown>;
}
export interface AcceptanceCriterion {
    id: string;
    description: string;
    test?: string;
    passes?: boolean;
}
/**
 * 加载 Spec 文件
 */
export declare function loadSpecFile(specPath: string): SpecContent;
/**
 * 解析 Markdown 格式的 Spec 文件
 */
export declare function parseSpecMarkdown(content: string, filePathOrId: string): SpecContent;
//# sourceMappingURL=spec-parser.d.ts.map