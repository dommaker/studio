# doc-manager-skill Evals - Iteration 1

## Test Method

模拟用户查询，检查 description 是否能触发 skill 识别。

## Should Trigger (positive)

| # | Query | Expected | Result |
|---|-------|----------|--------|
| 1 | "保存进度" | trigger | ✅ 触发（description 包含"保存进度"）|
| 2 | "更新 roadmap" | trigger | ✅ 触发 |
| 3 | "保存文档" | trigger | ✅ 触发 |
| 4 | "帮我写一个 spec" | trigger | ✅ 触发（description 包含"写 spec"）|
| 5 | "记录一下今天的进展" | trigger | ❌ 未触发（description 没有"记录进展"）|
| 6 | "创建设计文档" | trigger | ❌ 未触发（description 没有"创建设计文档"）|
| 7 | "更新这个文档" | trigger | ✅ 触发 |
| 8 | "把进度保存到 memory" | trigger | ❌ 未触发（description 没有"保存到 memory"）|
| 9 | "更新 Phase 3.29" | trigger | ❌ 未触发（description 没有"更新 Phase"）|
| 10 | "帮我创建一个 spec，依赖 AS-025" | trigger | ✅ 触发 |

## Should NOT Trigger (negative)

| # | Query | Expected | Result |
|---|-------|----------|--------|
| 1 | "审查这个 spec" | no trigger | ✅ 未触发 |
| 2 | "检查一下文档质量" | no trigger | ✅ 未触发 |
| 3 | "帮我分析架构" | no trigger | ✅ 未触发 |
| 4 | "运行测试" | no trigger | ✅ 未触发 |
| 5 | "提交代码" | no trigger | ✅ 未触发 |
| 6 | "读一下这个文件" | no trigger | ✅ 未触发 |
| 7 | "解释这段代码" | no trigger | ✅ 未触发 |
| 8 | "帮我调试问题" | no trigger | ✅ 未触发 |
| 9 | "创建 git 分支" | no trigger | ✅ 未触发 |
| 10 | "搜索相关文档" | no trigger | ✅ 未触发 |

## Results

- Positive: 6/10 = 60%
- Negative: 10/10 = 100%
- Overall: 16/20 = 80%

## Issues

- "记录进展"、"保存到 memory"、"更新 Phase" 等变体未覆盖
- description 关键词太少

## Next

优化 description 覆盖更多触发词变体。
