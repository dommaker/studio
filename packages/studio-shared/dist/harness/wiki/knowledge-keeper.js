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
import { createProjectPage, updateProjectPageExecutionResult, writeWikiPage, readWikiPage, listWikiPages, } from './wiki-service';
import { queryCompanyKnowledge, queryCompanySkills, queryCompanyPitfalls, formatQueryResults, } from './knowledge-query';
export class KnowledgeKeeper {
    static instance;
    static getInstance() {
        if (!KnowledgeKeeper.instance) {
            KnowledgeKeeper.instance = new KnowledgeKeeper();
        }
        return KnowledgeKeeper.instance;
    }
    // ══════════════════════════════════════════════
    // Query（查询）
    // ══════════════════════════════════════════════
    /** 搜索公司知识库（供 Analyst 辩论前查询） */
    query(companyId, query, maxResults = 5) {
        return queryCompanyKnowledge(companyId, query, maxResults);
    }
    /** 搜索公司技能（供 Executor dispatch 前加载） */
    querySkills(companyId, taskDescription, maxResults = 3) {
        return queryCompanySkills(companyId, taskDescription, maxResults);
    }
    /** 搜索已知坑位（供 Executor + Reviewer 参考） */
    queryPitfalls(companyId, taskDescription, maxResults = 3) {
        return queryCompanyPitfalls(companyId, taskDescription, maxResults);
    }
    /** 格式化查询结果为 prompt 注入文本 */
    formatForPrompt(results) {
        return formatQueryResults(results);
    }
    /** 判断是否冷启动（公司知识库为空） */
    isColdStart(companyId) {
        const pages = listWikiPages(companyId);
        return pages.length <= 1; // 只有 INDEX.md 或无文件
    }
    // ══════════════════════════════════════════════
    // Ingest（摄入）
    // ══════════════════════════════════════════════
    /** RequirementsDoc 产出 → 创建 Wiki 项目页初稿 */
    ingestProjectPage(companyId, pmoNumber, data) {
        createProjectPage(companyId, pmoNumber, data);
    }
    /** Execution 完成 → 更新项目页执行结果 */
    ingestExecutionResult(companyId, pmoNumber, result) {
        updateProjectPageExecutionResult(companyId, pmoNumber, result);
    }
    /** Skill 提取 → 写入 Wiki */
    ingestSkill(companyId, skill) {
        const skillId = skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
        writeWikiPage(companyId, {
            path: `skills/${skillId}.md`,
            title: skill.name,
            content: `## 模式\n${skill.pattern}\n\n## 描述\n${skill.description}\n\n## 分类\n${skill.category}\n\n## 来源\n${skill.sourceGoalIds.map(id => `- Goal: ${id}`).join('\n')}`,
            frontmatter: {
                maturity: 'draft',
                confidence: skill.confidence,
                category: skill.category,
                sourceGoalIds: skill.sourceGoalIds,
                published: skill.confidence >= 0.8,
                createdAt: new Date().toISOString(),
            },
        });
    }
    /** 通用页面写入（自定义路径+内容） */
    ingestPage(companyId, page) {
        writeWikiPage(companyId, page);
    }
    /** Pitfall 记录 → 写入 Wiki */
    ingestPitfall(companyId, pitfall) {
        const pitfallId = pitfall.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
        writeWikiPage(companyId, {
            path: `pitfalls/${pitfallId}.md`,
            title: pitfall.title,
            content: `## 问题\n${pitfall.problem}${pitfall.fix ? `\n\n## 修复\n${pitfall.fix}` : ''}\n\n## 关联\n- Task: ${pitfall.sourceTaskId || '—'}\n- Project: ${pitfall.sourceProjectId || '—'}\n\n## 处理\n${pitfall.reviewCycles ? `审查 ${pitfall.reviewCycles} 轮耗尽，需人工分析根因。` : '已记录，供后续参考。'}`,
            frontmatter: {
                maturity: 'draft',
                sourceTaskId: pitfall.sourceTaskId,
                sourceProjectId: pitfall.sourceProjectId,
                reviewCycles: pitfall.reviewCycles,
                createdAt: new Date().toISOString(),
            },
        });
    }
    // ══════════════════════════════════════════════
    // Read（读取）
    // ══════════════════════════════════════════════
    /** 读取 Wiki 页面 */
    readPage(companyId, relativePath) {
        return readWikiPage(companyId, relativePath);
    }
    /** 列出所有页面 */
    listPages(companyId) {
        return listWikiPages(companyId);
    }
}
export const knowledgeKeeper = KnowledgeKeeper.getInstance();
//# sourceMappingURL=knowledge-keeper.js.map