/**
 * Knowledge Keeper — 知识库守护者（统一角色入口）
 *
 * 收敛 wiki-service、knowledge-query 和散落的 Ingest 逻辑。
 * 其他角色（Analyst/Executor/Reviewer/Auditor）通过此类与公司知识库交互。
 *
 * 职责:
 *   Query  — 搜索公司知识库（供 Analyst/Executor 查询）
 *   Ingest — 摄入新知识（RequirementsDoc→项目页, Execution→更新, Skill/Pitfall→页面）
 *   Maintain — Wiki 结构维护（INDEX, 成熟度, 去重）
 */
import { type QueryResult } from './knowledge-query';
export interface KnowledgeKeeperConfig {
    baseDir?: string;
}
export declare class KnowledgeKeeper {
    private static instance;
    static getInstance(): KnowledgeKeeper;
    /** 搜索公司知识库（供 Analyst 辩论前查询） */
    query(companyId: string, query: string, maxResults?: number): QueryResult[];
    /** 搜索公司技能（供 Executor dispatch 前加载） */
    querySkills(companyId: string, taskDescription: string, maxResults?: number): QueryResult[];
    /** 搜索已知坑位（供 Executor + Reviewer 参考） */
    queryPitfalls(companyId: string, taskDescription: string, maxResults?: number): QueryResult[];
    /** 格式化查询结果为 prompt 注入文本 */
    formatForPrompt(results: QueryResult[]): string;
    /** 判断是否冷启动（公司知识库为空） */
    isColdStart(companyId: string): boolean;
    /** RequirementsDoc 产出 → 创建 Wiki 项目页初稿 */
    ingestProjectPage(companyId: string, pmoNumber: string, data: {
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
    /** Execution 完成 → 更新项目页执行结果 */
    ingestExecutionResult(companyId: string, pmoNumber: string, result: {
        acGroupId?: string;
        status: 'succeeded' | 'failed';
        summary: string;
        changedFiles?: string[];
        error?: string;
    }): void;
    /** Skill 提取 → 写入 Wiki */
    ingestSkill(companyId: string, skill: {
        name: string;
        description: string;
        category: string;
        pattern: string;
        confidence: number;
        sourceGoalIds: string[];
    }): void;
    /** 通用页面写入（自定义路径+内容） */
    ingestPage(companyId: string, page: {
        path: string;
        title: string;
        content: string;
        frontmatter?: Record<string, unknown>;
    }): void;
    /** Pitfall 记录 → 写入 Wiki */
    ingestPitfall(companyId: string, pitfall: {
        title: string;
        problem: string;
        fix?: string;
        sourceTaskId?: string;
        sourceProjectId?: string;
        reviewCycles?: number;
    }): void;
    /** 读取 Wiki 页面 */
    readPage(companyId: string, relativePath: string): string | null;
    /** 列出所有页面 */
    listPages(companyId: string): string[];
}
export declare const knowledgeKeeper: KnowledgeKeeper;
//# sourceMappingURL=knowledge-keeper.d.ts.map