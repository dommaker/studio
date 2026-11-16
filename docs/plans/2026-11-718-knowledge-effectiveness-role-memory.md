# #718 知识效果评估与角色记忆生命周期

## 验收映射

1. 知识消费/结果事件携带 WU、Assignment、StepRecord 与最终 verification；条目引用可追溯到执行轮次，而非仅共现。
2. `getFlywheelMetrics` 按有知识/无知识分组计算成功率与差值，保留负反馈，并按条目曝光与成功结果评估检索质量；注入频次不直接等于改进。
3. 角色记忆 topic 保存 learning scope、usage、lastVerification、stale/conflicting 与 supersession；prompt 注入在 token 预算前过滤不适用记忆，原文仍可浏览。
4. 角色记忆维护以持久 run 执行 promote/merge/archive/capacity；未完成 run 启动恢复，重复执行不重复正文或丢失归档原文。

## 公共测试 seam（已确认）

- `KnowledgeService.recordOutcome/getFlywheelMetrics`
- `RoleMemoryStore` 的适用索引与生命周期操作
- `RoleMemoryMaintenance` 的执行/恢复入口
- `composeStepPrompt` 的记忆过滤接线

不新增 Web/HTTP 管理面；保留现有 review-proposal 审批入口。

## 实施步骤

1. 先扩展 knowledge outcome 类型与 agent-loop 调用，RED 验证 Assignment/StepRecord/final verification 落事件；再实现事件与条目引用关联。
2. 先写效果指标 RED：有/无知识对照、负向 delta、条目级检索质量与数据不足；再替换仅以注入频率定义 improvement 的旧口径。
3. 先写 role-memory 生命周期 RED：learning/scope 往返、usage/verification、stale/conflicting/superseded 过滤；再实现适用索引并接入 prompt-composer。
4. 先写 maintenance RED：run 先于副作用、幂等 merge/archive、capacity 实消费、崩溃恢复；再实现持久 run 和启动恢复，auto/approve promote 复用该入口。
5. 更新数据目录契约与相关 CONTEXT.md；运行定向测试、typecheck、`vitest run --changed origin/master`，执行 code-review 后提交并关闭 #718。
