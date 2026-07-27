# Studio Agent 工作区指南

## 可用 Skills（索引）
- **arch-review-skill** — 对照 arch-patterns 知识库检查架构文档的概念完整性和覆盖度，识别 P0/P1 缺口。
- **code-review** — 实现完成且测试通过后，对代码执行多维度质量审查（AC 覆盖、质量、架构一致性、安全、边界）。
- **dead-code-removal** — 彻底清理已废弃的代码概念：跨 schema、后端、前端、packages 全链路删除。
- **design-analyst** — 把模糊需求变成结构化设计文档（方案对比、AC 定义、风险评估），或对系统/架构/方案做评估分析。
- **doc-manager-skill** — 文档状态管理：保存进度到 memory、维护文档格式、更新 roadmap Phase、同步 spec/SDD status。
- **exploration-sediment** — 调研/探索结论沉淀：把本轮调研的耐久发现与修复写入对应目录 CONTEXT.md（注意事项/核心导出/修复历史），避免下个会话重复探索。
- **knowledge-extraction** — 从近期工作产物中提取可复用知识，去重后写入知识库（Loop 自动触发，也支持用户请求）。
- **knowledge-quality-skill** — 审查知识库条目的语义质量：内容完整性、价值、跨条目矛盾、引用存活、语义重复。
- **knowledge-synthesis-skill** — 从时间窗口的知识集合中产出高阶洞察：语义模式检测与经验教训综合（Loop 自动触发）。
- **migration-execution-skill** — 执行大规模、跨文件的代码库增量迁移（Round 分解 → 转换 → 验证 → 级联修复）。
- **parallel-execution** — 多个独立任务并行执行：为每个任务分配独立 agent，收集结果并汇总汇报。
- **requirement-clarify** — 需求表述模糊或缺关键信息时，做多轮聚焦澄清（每轮 1-3 个关键问题+建议答案），澄清完成输出结构化结论并指导 pm 建 Requirement 挂 PMO 项目。
- **sdd-review-skill** — 对 requirement.md、design.md、task.md 执行 SDD 质量审查与 AC Group 验证。
- **spec-review-skill** — 审查 docs/specs/ 中 spec 文档的质量、状态准确性与 SDD 就绪度。
- **task-planner** — 把设计文档转化为可执行的 SDD 三层文档（requirement.md + design.md + task.md）。
- **tdd-implement** — 读取 SDD 按 TDD 实现代码：先写 FAIL 测试（RED），再实现让测试通过（GREEN）。
- **test-diagnosis** — 测试失败时诊断根因：区分环境问题、依赖问题、代码问题三层，提供系统化 fallback 排查。

各 skill 全文位于 `.studio/skills/<name>/SKILL.md`，与任务相关时按需阅读。

## SDD 落盘要求
- 产出设计文档时：写 `docs/sdd/<slug>/requirement.md`、`docs/sdd/<slug>/design.md`、`docs/sdd/<slug>/task.md`。
- 并在 `docs/sdd/_index.md` 登记该 slug（标题、状态、关联 REQ/任务）。
