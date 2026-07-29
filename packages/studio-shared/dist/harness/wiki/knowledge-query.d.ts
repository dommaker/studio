/**
 * Knowledge Keeper 查询 — 搜索公司 Wiki 知识库
 *
 * 供 Analyst/Executor/Reviewer 在启动时查询历史经验。
 * 使用简单文本匹配 + INDEX 遍历（后续可升级为语义搜索）。
 */
export interface QueryResult {
    pagePath: string;
    title: string;
    relevance: number;
    snippet: string;
}
/**
 * 查询公司知识库
 * @param companyId 公司 ID
 * @param query 搜索关键词（空格分隔）
 * @param maxResults 最大返回数
 */
export declare function queryCompanyKnowledge(companyId: string, query: string, maxResults?: number): QueryResult[];
/**
 * 查询技能（专门搜索 skills/ 目录）
 */
export declare function queryCompanySkills(companyId: string, taskDescription: string, maxResults?: number): QueryResult[];
/**
 * 查询坑位（专门搜索 pitfalls/ 目录）
 */
export declare function queryCompanyPitfalls(companyId: string, taskDescription: string, maxResults?: number): QueryResult[];
/**
 * 格式化查询结果为 prompt 注入文本
 */
export declare function formatQueryResults(results: QueryResult[]): string;
//# sourceMappingURL=knowledge-query.d.ts.map