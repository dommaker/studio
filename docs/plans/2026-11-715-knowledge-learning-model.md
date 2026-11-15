# #715 建立知识作用域、来源、版本和结果模型

## 目标

- 用可持久化的学习元数据关联 WU/Assignment/StepRecord、repo、commit、transcript/证据、提取版本、revision/supersedes 与执行结果。
- 自动召回先按 global/company/project/repo/role 过滤，再执行成熟度排序、数量限制与 token 预算；被新版替代及 low_quality 条目不进入自动注入。
- 旧条目（包括 archived/deprecated 与未知作用域）继续可浏览；只有显式、可靠来源才能写入作用域，人工可补全未知作用域。
- 失败和未合并产物保留结构化结果标签；人工及周期晋升都不得把缺少已验证交付证据的条目晋为 proven。

## 已确认测试接缝

1. `learning-metadata.ts`：元数据读写、五级作用域匹配、proven 资格纯函数。
2. `UnifiedQuery` / `knowledge-service-inject-wiring`：真实 FileKnowledgeStore 验证字段往返、legacy 浏览、作用域/质量/替代过滤先于 limit 与预算。
3. `knowledge-service-extract-conversation` / `agent-loop-extract-conversation`：提取在最终守卫及 StepRecord 持久化后触发，来源与结果完整。
4. `knowledge-service.test.ts` / `monitor-system-probes.test.ts`：人工和自动 proven 门禁。
5. `entries.routes.test.ts`：legacy 浏览、low_quality 一致政策与人工作用域补全。

## 实施步骤

1. 先补上述 RED；新增 Studio 侧 `LearningMetadata`，挂在现有 `sourceReferences[].learning` 下，利用 harness 已持久化的嵌套来源对象，不修改外部包或引入第二存储。
2. 在 UnifiedQuery 与 injectContext 贯通 scope/low_quality/supersession；合成全局规则、偏好和环境条目显式标 global，浏览显式包含历史终态。
3. 扩展提取与 recordPattern 入参；COMPLETE 提取移至最终 action 和 StepRecord 落库之后，写入完整来源、版本与 failed/unmerged/verified 结果。
4. prompt-composer 传当前 role/project/repo；人工创建与 PATCH 补全入口写显式 scope；人工和日级自动晋升共用 proven 结果门。
5. 更新 contract 与 knowledge/agent-loop/ops CONTEXT；运行相关单文件测试、受影响测试和 typecheck，code-review 后提交当前 master。

## 非目标

- 不实现 #716 的提取重试状态机、#717 的 Skill 发布或 #718 的角色记忆生命周期/效果评估。
- 不自动猜测 legacy global 作用域，不改写历史条目，不新建数据库。
- 不在本票回填最终 merge 后的跨阶段结果传播；初始未合并标签和 proven 门禁由本票保证。
