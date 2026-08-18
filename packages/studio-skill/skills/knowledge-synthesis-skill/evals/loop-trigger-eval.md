# knowledge-synthesis-skill Evals

## 测试方法

Loop-trigger 场景：模拟定时调度 prompt，检查 Agent 是否能正确路由到 knowledge-synthesis-skill。

---

## Loop-trigger 场景测试

### Should Trigger (positive)

| # | Prompt | Expected | Result |
|---|--------|----------|--------|
| 1 | "执行每周知识综合：扫描过去 7 天的知识条目，产出 skill 提议和经验总结" | trigger | ✅ 触发（"知识综合" + "skill 提议" 在 description 中）|
| 2 | "检测最近知识条目中的重复模式" | trigger | ✅ 触发（"重复模式" + "知识条目" 匹配）|
| 3 | "从过去一周的知识中提炼经验教训" | trigger | ✅ 触发（"提炼经验" + "知识" 匹配）|
| 4 | "检查知识库有没有值得做成 skill 的模式" | trigger | ✅ 触发（"做成 skill 的模式" 直接匹配）|
| 5 | "综合一下这周学到的关键教训" | trigger | ✅ 触发（"综合" + "教训" 匹配）|

### Should NOT Trigger (negative)

| # | Prompt | Expected | Result |
|---|--------|----------|--------|
| 1 | "从这次调试中提取一条 pitfall" | no trigger | ✅ 未触发（单次提取 → knowledge-extraction-skill）|
| 2 | "检查这条 guideline 的内容质量" | no trigger | ✅ 未触发（单条目审查 → knowledge-quality-skill）|
| 3 | "运行 harness knowledge audit" | no trigger | ✅ 未触发（格式检查 → CLI）|
| 4 | "帮我创建一个新 skill" | no trigger | ✅ 未触发（创建 skill → skill-creator）|
| 5 | "保存今天的进展" | no trigger | ✅ 未触发（保存进度 → doc-manager-skill）|

---

## 结果汇总

- Positive: 5/5 = 100%
- Negative: 5/5 = 100%
- **Overall: 10/10 = 100%**

## 结论

description 覆盖了关键触发场景：
- "时间窗口的知识集合" → 区别于单次提取
- "语义模式检测" + "skill 提议" → 区别于质量检测
- "经验教训综合" → 区别于单次反馈提取
- "NOT for single-entry quality review" → 明确边界
