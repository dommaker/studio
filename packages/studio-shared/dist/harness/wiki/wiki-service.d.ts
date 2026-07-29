/**
 * Wiki Service — 公司知识库的 Markdown 页面读写
 *
 * 文件结构:
 *   ~/knowledge-base/companies/{companyId}/wiki/
 *     projects/PMO-xxx.md
 *     skills/
 *     pitfalls/
 *     concepts/
 *     decisions/
 *     audit/
 *     INDEX.md
 */
export interface WikiPage {
    path: string;
    title: string;
    content: string;
    frontmatter?: Record<string, unknown>;
}
/**
 * 写入 Wiki 页面
 */
export declare function writeWikiPage(companyId: string, page: WikiPage): void;
/**
 * 读取 Wiki 页面
 */
export declare function readWikiPage(companyId: string, relativePath: string): string | null;
/**
 * 创建项目页初稿（从 RequirementsDoc）
 */
export declare function createProjectPage(companyId: string, pmoNumber: string, data: {
    title: string;
    summary: string;
    acGroups: {
        id: string;
        acs: string[];
        files: string[];
        dependencies: string[];
    }[];
    constraints: string[];
    meetingId?: string;
    goalId?: string;
}): void;
/**
 * 列出公司所有 Wiki 页面
 */
export declare function listWikiPages(companyId: string): string[];
/**
 * 更新项目页的执行结果部分（Executor 完成后调用）
 */
export declare function updateProjectPageExecutionResult(companyId: string, pmoNumber: string, result: {
    acGroupId?: string;
    status: 'succeeded' | 'failed';
    summary: string;
    changedFiles?: string[];
    error?: string;
}): void;
//# sourceMappingURL=wiki-service.d.ts.map