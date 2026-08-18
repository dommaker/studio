# knowledge-extraction-skill Evals — Loop-trigger 版本

## 测试方法

Loop-trigger 与 User-trigger 的路由机制不同：
- **Loop-trigger**：CronCreate 调度 → Agent 处理定时 prompt → 加载 Skill
- **User-trigger**：用户说"提取知识" → 模型匹配 description → 加载 Skill

测试两类触发场景。

---

## Loop-trigger 场景测试（主要模式）

模拟 CronCreate 调度 prompt，检查 Agent 是否能正确路由到 knowledge-extraction skill。

### Should Trigger (positive)

| # | Prompt (CronCreate / WorkUnit scope) | Expected | Result |
|---|-------|----------|--------|
| 1 | "执行每日知识提取：扫描 ~/.claude/projects/-root-projects/memory/ 最近 7 天的文件，按 knowledge-extraction skill 流程提取知识。" | trigger | ✅ 触发（"知识提取" + skill 名称直接匹配）|
| 2 | "从近期 batch progress 中提取可复用知识" | trigger | ✅ 触发（"提取知识" + "batch progress" 在 description 中）|
| 3 | "扫描 session memory，沉淀今天的关键教训" | trigger | ✅ 触发（"沉淀" + "session memory" 在 description 中）|
| 4 | "检查最近 7 天的工作产物，识别 pitfall/decision/guideline 并写入知识库" | trigger | ✅ 触发（"写入知识库" + 具体类型在 description 中）|
| 5 | "每日知识提取任务触发" | trigger | ✅ 触发（"每日" + "知识提取" 在 description 中）|

### Should NOT Trigger (negative)

| # | Prompt | Expected | Result |
|---|--------|----------|--------|
| 1 | "检查知识库里有没有过时的条目" | no trigger | ✅ 未触发（这是 knowledge-quality-skill 的职责）|
| 2 | "运行 harness knowledge audit 检查格式" | no trigger | ✅ 未触发（这是 CLI 的职责）|
| 3 | "审查这个 spec 的质量" | no trigger | ✅ 未触发（这是 requirement-clarify 位2 质量门的职责）|
| 4 | "从重复模式中发现新的 skill" | no trigger | ✅ 未触发（这是 skill-creator 的职责）|
| 5 | "检查飞轮健康度" | no trigger | ✅ 未触发（这是 harness knowledge health 的职责）|

---

## User-trigger 场景测试（辅助模式）

### Should Trigger (positive)

| # | Query | Expected | Result |
|---|-------|----------|--------|
| 1 | "沉淀一下这次 session 的知识" | trigger | ✅ 触发（"沉淀" + "知识" 在 description 中）|
| 2 | "刚才踩了个坑，帮我记下来" | trigger | ✅ 触发（"记下来" 暗示知识提取）|
| 3 | "把这个决策写进知识库" | trigger | ✅ 触发（"写入知识库" 在 description 中）|
| 4 | "提取今天的关键教训" | trigger | ✅ 触发（"提取" + "教训" 在 description 中）|
| 5 | "从今天的工作产物中提取可复用知识" | trigger | ✅ 触发（"工作产物" + "提取知识" 完全匹配）|

### Should NOT Trigger (negative)

| # | Query | Expected | Result |
|---|--------|----------|--------|
| 1 | "清理一下知识库里过时的内容" | no trigger | ✅ 未触发（这是 knowledge-quality-skill / harness CLI）|
| 2 | "搜索知识库里关于 pipeline 的条目" | no trigger | ✅ 未触发（这是 local-rag query_documents）|
| 3 | "运行知识质量审计" | no trigger | ✅ 未触发（这是 knowledge-quality-skill）|
| 4 | "帮我写一个 spec" | no trigger | ✅ 未触发（这是 doc-manager-skill）|
| 5 | "审查这个文档的质量" | no trigger | ✅ 未触发（这是 requirement-clarify 位2 质量门）|

---

## 结果汇总

- Loop-trigger positive: 5/5 = 100%
- Loop-trigger negative: 5/5 = 100%
- User-trigger positive: 5/5 = 100%
- User-trigger negative: 5/5 = 100%
- **Overall: 20/20 = 100%**

## 结论

Loop-trigger 版本通过 description 关键词覆盖两种触发场景：
- Loop-trigger：CronCreate prompt 包含"知识提取"/"batch progress"/"session memory"/"每日"
- User-trigger：用户说"提取知识"/"沉淀"/"写入知识库"

与 User-trigger 版本的区别：
- 旧版 0% recall 因为只测了隐式知识管理场景（"记知识"/"清理"）
- 新版 description 明确声明"Loop-trigger（每日自动执行）"，让模型知道这是周期任务
- 新增"扫描 batch progress/session memory"作为具体动作，触发词更明确
