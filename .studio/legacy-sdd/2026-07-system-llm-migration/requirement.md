---
status: done
version: "1.0"
slug: 2026-07-system-llm-migration
title: 系统级 LLM 调用迁移 + A2A Backlog 整合
created: 2026-07-21
sources:
  - docs/plans/2026-07-system-llm-migration.md
  - docs/plans/2026-07-agent-to-agent-collab-design.md (§4 §9 §10)
tags:
  - migration
  - llm-removal
  - agent-network
  - a2a
  - system-executor
  - reviewer-role
---

## 源项目清单

| # | 源项目 | 产出类型 | SDD AC |
|---|--------|---------|--------|
| S-01 | 内置 `studio` 角色（ensureStudioProfile 启动时创建，不 mount loop，UI 不可见） | 代码 | AC Group 1 |
| S-02 | `systemExecutor` 抽象（封装 spawn CLI + token 度量，复用 Executor/AgentTask/ExecutionResult） | 代码 | AC Group 1 |
| S-03 | `buildSpawnEnv` 简化（过渡期保留，不注入 key/MODEL/DATABASE_URL） | 代码 | AC Group 1 |
| S-04 | 前端提醒机制（studio 角色 provider=null 弹框 + 无角色弹框 + in_review 无 reviewer 提醒） | 代码 + UI | AC Group 2 |
| S-05 | 角色初始化向导（§9.4：扫描节点 runtimes -> 勾选 -> 建 AgentProfile） | 代码 + UI | AC Group 2 |
| S-06 | `knowledge-maintenance.ts` 4 处 `modelGateway.promptJson` 改 systemExecutor | 代码 | AC Group 3 |
| S-07 | `triage-agent.service.ts:378` LLM 兜底改 systemExecutor | 代码 | AC Group 3 |
| S-08 | `knowledge-service.ts:512` `extractFromConversation` 改 systemExecutor | 代码 | AC Group 3 |
| S-09 | `evolution.service.ts:99,196` 2 处改 systemExecutor | 代码 | AC Group 3 |
| S-10 | `skill-extraction.service.ts:302` 改 systemExecutor | 代码 | AC Group 3 |
| S-11 | `decision-chain-extractor.ts:87` 改 systemExecutor | 代码 | AC Group 3 |
| S-12 | `entries.routes.ts:101` 用户问答改 systemExecutor | 代码 | AC Group 3 |
| S-13 | `improver-scheduler.service.ts` dead code 删除（startScheduler 从未调用） | 代码 | AC Group 3 |
| S-14 | `modelGateway` 全局 `prompt/promptJson` 调用归零后，`model-gateway.ts`/`provider-registry.ts`/`model-router.ts` 标 deprecated | 代码 | AC Group 3 |
| S-15 | review-agent 重构为系统代派 WorkUnit（监听 `workunit.status_changed -> in_review` + 频道有 reviewer 角色 -> 创建 type='review' 子 WU） | 代码 | AC Group 4 |
| S-16 | reviewer 角色搭配 `code-review` skill（已存在 `~/.studio/skills/code-review`），确认 skillLoader 路径覆盖 | 文档 + 代码 | AC Group 4 |
| S-17 | A2A §4.3 P2 预算闸门接通（`delegation-gate.ts:checkTreeBudget` 按 rootId 聚合 `workunit:tokens` -> TREE_TOKEN_BUDGET=400K 校验） | 代码 | AC Group 5 |
| S-18 | A2A §4.2 P2 深度放开到 MAX_DEPTH=2（env `STUDIO_COLLAB_MAX_DEPTH=2`，默认 2） | 代码 | AC Group 5 |
| S-19 | A2A P2 树聚合只读接口（`GET /api/v1/workunits/:id/tree-tokens` 复用 token-usage.service.ts 读取模式） | 代码 | AC Group 5 |
| S-20 | A2A P2 树状开销 UI（父 WU 抽屉树视图 + 根部合计 + 距预算余量） | 代码 + UI | AC Group 5 |
| S-21 | A2A P2 delegate 卡片带开销（显示"树开销 x/预算"） | 代码 + UI | AC Group 5 |
| S-22 | A2A §10.1-5 P2 频道默认管线展开（频道声明默认链 -> feature 类任务展开为父子 WU 树，复用 DELEGATE 机制第一跳由代码发起） | 代码 | AC Group 6 |
| S-23 | A2A §10.6 P2 skill 降级通路（`skill-demotion.ts` 已有骨架 -> 接通人审通道 + 桥到 `archived` 状态写 frontmatter） | 代码 | AC Group 6 |
| S-24 | 删除 `model-gateway.ts`/`provider-registry.ts`/`model-router.ts`/`usage-tracker.ts`（含 `__tests__`） | 代码 | AC Group 7 |
| S-25 | 删除 `spawn-claude-cli.ts`（含 `buildSpawnEnv` + `__tests__`） | 代码 | AC Group 7 |
| S-26 | 删除全局 key 环境变量 `STUDIO_API_KEY`/`STUDIO_BASE_URL`/`PIPELINE_API_KEY`/`PIPELINE_BASE_URL`/`KNOWLEDGE_API_KEY`/`KNOWLEDGE_BASE_URL`（从 `index.ts`/`config.service.ts`/`proxy.ts`/`internal.routes.ts`/`cli/config.ts` 移除引用） | 代码 + 配置 | AC Group 7 |
| S-27 | 删除 `config/index.ts` 的 `PROVIDER_KEY_MAP`/`getProviderApiKey`/`WorkloadType`（含 `__tests__/getProviderApiKey.test.ts`） | 代码 | AC Group 7 |
| S-28 | 清理 `~/.claude/settings-deepseek.json` 硬编码 `STUDIO_API_KEY` 明文 | 配置 | AC Group 7 |
| S-29 | 更新 A2A §10.1 第 8 条"双轨架构"（飞轮闭环走 studio 角色，不再 hub 直连全局 key） | 文档 | AC Group 7 |
| S-30 | A2A §9.6 P1 RemoteExecutor（节点任务通道路由 AgentTask -> 远程节点 task-executor 执行 -> 结果回传；`profile.nodeId === 'local'` -> LocalExecutor，否则 RemoteExecutor） | 代码 | AC Group 8 |
| S-31 | A2A §9 P1 节点离线兜底（心跳超时 -> profile 显示离线；已 claim WU 由 workunit-timeout 释放） | 代码 | AC Group 8 |

---

## AC Group 1: studio 内置角色 + systemExecutor 抽象

**covers**: [S-01, S-02, S-03]

**目标**：建立系统级 LLM 调用新基座。studio 内置角色作为系统任务执行身份，systemExecutor 封装 spawn 逻辑。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-1.1 | API 启动时 `ensureStudioProfile()` 幂等创建 name='studio' 的 AgentProfile | `studio-api` 进程启动 | profile 存在（已存在则跳过，不重复创建）；status='active'；provider=null（部署时由前端配置）；channels=空数组；description=null | FileStore 损坏 -> 抛错并 log，不阻塞启动 | 不通过 `AgentProfileService.create` 走事件流（避免触发 mount），直接 `fileStore.createProfile` |
| AC-1.2 | 用户创建/重命名角色时禁止 name='studio' | `POST /api/v1/agent-profiles` body.name='studio' 或 `PATCH` 改名为 'studio' | 400 拒绝，错误信息 "name 'studio' is reserved" | 大小写变体 `Studio`/`STUDIO` -> 允许（不保留） | 不影响存量用户角色 |
| AC-1.3 | `agentLoopRegistry.mount(profile)` 跳过 `profile.name === 'studio'` | 启动 mount 循环或 created 事件回调 | studio 角色 mount 返回 `{ status: 'skipped', reason: 'system role' }`，不创建 AgentLoop，不消耗 trigger | - | studio 角色 provider 改变时不触发 mount/unmount |
| AC-1.4 | `AgentProfileService.list` 默认排除 name='studio' | `GET /api/v1/agent-profiles` | 返回列表不含 studio 角色；`?includeSystem=true` 查询参数返回时包含 | 按 channelId 过滤时 studio 角色不出现（其 channels=空，自然不在任何频道成员列表） | 不影响 update/delete（前端不会拿到 id） |
| AC-1.5 | `AgentProfileService.delete` 拒绝删除 studio 角色 | `DELETE /api/v1/agent-profiles/:id` where name='studio' | 400 拒绝，错误信息 "studio role cannot be deleted" | - | - |
| AC-1.6 | `systemExecutor` 模块存在于 `apps/api/src/modules/agents/system-executor.ts` | 新建文件后 | `ls` 确认存在；导出 `systemExecutor` 单例 + `SystemExecutor` class + 类型 `SystemExecutorOptions`/`SystemExecutorResult` | - | - |
| AC-1.7 | `systemExecutor.run(prompt, options?)` 返回 `SystemExecutorResult` | 调用 run | 内部：读 studio 角色 provider -> resolveProviderDefinition -> buildArgsFromTemplate({ outputFormat: 'json' }) -> execSh -> 解析 JSON envelope.usage -> 返回 `{ output, usage, durationMs }` | studio 角色 provider=null -> 抛 `StudioRoleNotConfiguredError`；CLI 失败 -> 抛原 Error（fire-and-forget 调用方 catch） | 不走 AgentTask/Executor/agentRunner，直接 spawn（systemExecutor 是轻量调用，不需 AgentLoop 状态机） |
| AC-1.8 | `systemExecutor.runJson<T>(prompt, options?)` 返回解析后 JSON | 调用 runJson | 在 run() 基础上 JSON.parse(output)；解析失败 -> 抛 `SystemExecutorJsonParseError` 含 raw output | LLM 输出非 JSON -> 抛错不 fallback（与 `modelGateway.promptJson` 行为一致） | - |
| AC-1.9 | `SystemExecutorOptions` 支持 `systemPrompt`/`cwd`/`allowedTools`/`timeoutMs`/`maxBuffer` | 类型定义 | 默认值：timeoutMs=30_000，maxBuffer=5MB；cwd=undefined（继承 process.cwd）；allowedTools=undefined | - | 不支持 sessionId（系统任务无状态） |
| AC-1.10 | systemExecutor 执行后写 `studio-events.jsonl` `system:tokens` 事件 | 每次 run/runJson 完成 | 事件 payload：`{ type: 'system:tokens', provider, inputTokens, outputTokens, durationMs, promptSignature }`（promptSignature = hash(prompt).slice(0,8) 用于去重统计）；fire-and-forget，写失败只 log | usage 缺失 -> inputTokens/outputTokens 记 null 不编造 | 不写 `workunit:tokens`（系统任务无 WU） |
| AC-1.11 | `buildSpawnEnv` 简化为 `{ ...extra }`（不注入 key/MODEL/DATABASE_URL） | 重构后 | 调用 `buildSpawnEnv({ role: 'reviewer' })` 返回 `{}`；`buildSpawnEnv({ extra: { FOO: 'bar' } })` 返回 `{ FOO: 'bar' }` | - | 保留 `SpawnEnvOptions` 类型签名（消费方未迁移完前不破坏编译）；过渡期 `studio-agent` 包仍 import buildSpawnEnv |
| AC-1.12 | `buildSpawnEnv` 标 `@deprecated`，JSDoc 指向 systemExecutor | 重构后 | grep `@deprecated` 命中 `spawn-claude-cli.ts:buildSpawnEnv` | - | - |

**不做**：不在 AC Group 1 迁移任何 modelGateway 调用点（AC Group 3 做）。不删除 buildSpawnEnv（AC Group 7 做）。

---

## AC Group 2: 前端提醒 + 角色初始化向导

**covers**: [S-04, S-05]

**目标**：引导用户配置 studio 角色 provider 和创建 reviewer 角色通道。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-2.1 | 前端启动时 `GET /api/v1/agent-profiles?includeSystem=true` | App 加载 | 响应包含 studio 角色；前端识别 `name === 'studio'` | 404/网络错误 -> 静默，不阻塞 UI | - |
| AC-2.2 | studio 角色 provider=null 时弹框提醒 | 检测到 studio.provider === null | 模态框："系统执行角色未配置，请选择 CLI" + provider 下拉（claude/kimi/codex/opencode）+ 确认按钮调 `PATCH /api/v1/agent-profiles/:id` 写 provider | 用户关闭弹框 -> 不再弹（sessionStorage 标记），下次启动再弹 | 已配 provider -> 不弹 |
| AC-2.3 | 无用户角色（list 不含任何非 studio active profile）时弹框提醒 | 检测到 profiles.filter(p => p.name !== 'studio').length === 0 | 模态框："请创建角色以启用 Agent Network" + name + description + provider 表单 -> `POST /api/v1/agent-profiles` | 用户关闭 -> 不再弹（sessionStorage） | - |
| AC-2.4 | WorkUnit in_review 状态且频道无 reviewer 角色时前端提醒 | WorkUnit 详情页加载，status='in_review' 且 channel.members 中无任何匹配 reviewer skill 的 profile | 顶部横幅："建议创建 reviewer 角色以启用自动审查" + 跳转链接到角色初始化向导 | 频道有 reviewer 角色 -> 不显示横幅 | 不阻塞 review-passed/review-rejected 手动 API |
| AC-2.5 | 角色初始化向导页 `/setup/roles` 存在 | 路由创建后 | 页面展示 daemon 上报的 runtime 清单（`GET /api/v1/daemons/runtimes`）；每项含 binary/version/nodeId；用户勾选后填 name + description -> 批量 `POST /agent-profiles` | runtime 清单为空 -> 显示"未检测到 CLI，请先安装 claude/kimi/codex/opencode 之一" | 复用 ChannelMemberManager 表单组件（补 description + provider 字段） |
| AC-2.6 | `GET /api/v1/daemons/runtimes` 返回已注册 daemon 的 runtime 清单 | 接口创建后 | 响应 `{ runtimes: [{ nodeId, provider, binary, version, lastSeenAt }] }`；空列表时返回 `[]` | daemon 离线 -> runtime 不返回 | - |

**不做**：不强制用户必须配置才能使用（提醒而非阻塞）。

---

## AC Group 3: 系统级 LLM 调用迁移

**covers**: [S-06, S-07, S-08, S-09, S-10, S-11, S-12, S-13, S-14]

**目标**：10 处 modelGateway 调用全部改 systemExecutor；dead code 删除；modelGateway 标 deprecated。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-3.1 | `knowledge-maintenance.ts` 4 处 `modelGateway.promptJson` 改 `systemExecutor.runJson` | 重构后 | `grep "modelGateway" knowledge-maintenance.ts` -> 0 matches；`grep "systemExecutor" knowledge-maintenance.ts` -> >= 4 matches | systemExecutor 抛错 -> catch + log，行为与现状一致（批失败跳过） | 不改 prompt 文本（保持 LLM 输出契约） |
| AC-3.2 | `triage-agent.service.ts:378` 改 `systemExecutor.run` | 重构后 | `grep "modelGateway" triage-agent.service.ts` -> 0 matches；LLM 兜底走 systemExecutor.run | systemExecutor 失败 -> escalate 路径不变 | - |
| AC-3.3 | `knowledge-service.ts:512` `extractFromConversation` 改 `systemExecutor.runJson` | 重构后 | `grep "modelGateway" knowledge-service.ts` -> 0 matches | - | - |
| AC-3.4 | `evolution.service.ts` 2 处改 `systemExecutor.runJson` | 重构后 | `grep "modelGateway" evolution.service.ts` -> 0 matches | - | - |
| AC-3.5 | `skill-extraction.service.ts:302` 改 `systemExecutor.runJson` | 重构后 | `grep "modelGateway" skill-extraction.service.ts` -> 0 matches | - | - |
| AC-3.6 | `decision-chain-extractor.ts:87` 改 `systemExecutor.runJson` | 重构后 | `grep "modelGateway" decision-chain-extractor.ts` -> 0 matches | - | - |
| AC-3.7 | `entries.routes.ts:101` 用户问答改 `systemExecutor.run` | 重构后 | `grep "modelGateway" entries.routes.ts` -> 0 matches | systemExecutor 失败 -> 500 错误响应（与现状一致） | - |
| AC-3.8 | `improver-scheduler.service.ts` 文件不存在 | 删除后 | `ls apps/api/src/modules/knowledge/improver-scheduler.service.ts` -> not found；`grep "improver-scheduler" apps/api/src/` -> 0 matches（除 dist/） | `__tests__/improver-scheduler.service.test.ts` 同步删除 | - |
| AC-3.9 | `apps/api/src/` 全量 `grep "modelGateway\.\(prompt\|promptJson\|chat\)"` -> 0 matches | 全部迁移完成后 | grep 命令输出空 | 测试文件中的 mock 引用允许（标注 `vi.mock`） | dist/ 不检查 |
| AC-3.10 | `model-gateway.ts` 顶部加 `@deprecated` JSDoc，指向 systemExecutor | 重构后 | grep `@deprecated` 命中 model-gateway.ts | - | 不删除文件（AC Group 7 做） |
| AC-3.11 | `index.ts:69 modelGateway.loadFromEnv()` 调用前加 `// TODO(AC Group 7): remove with modelGateway` | 重构后 | grep 命中 TODO 注释 | - | - |
| AC-3.12 | 10 处迁移后 systemExecutor 调用均有对应测试 | 测试补充后 | 每处迁移点至少 1 个测试用例（success + failure path）；新增 `system-executor.test.ts` 覆盖 run/runJson/错误路径 | - | 不要求 e2e |

**不做**：不在 AC Group 3 删除 modelGateway 模块（AC Group 7 做）。不迁移 `improver-scheduler`（直接删除）。

---

## AC Group 4: review 系统代派

**covers**: [S-15, S-16]

**目标**：WorkUnit 转 in_review 时系统自动创建 review 子 WU 派给频道 reviewer 角色，reviewer 通过 code-review skill 执行审查。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-4.1 | `ReviewDispatcher` 服务存在于 `apps/api/src/modules/agents/review-dispatcher.ts` | 新建文件后 | `ls` 确认；导出 `reviewDispatcher` 单例 + `ReviewDispatcher` class | - | - |
| AC-4.2 | 订阅 `workunit.status_changed` 事件 | status='in_review' 时触发 | 读取 wu.channelId -> 查 channel.members -> 过滤匹配 reviewer 角色的 profile（profile.description 含 `reviewer` 关键词或 channels 含当前频道） | channelId 为空 -> 跳过；无 reviewer 角色 -> 跳过（前端提醒由 AC-2.4 处理） | 不改 VALID_TRANSITIONS |
| AC-4.3 | 找到 reviewer 角色时创建子 WorkUnit | 触发条件满足 | 子 WU：`parentId=父id, assigneeId=reviewer.profile.id, type='review', scope="审查代码变更：<父 scope>", channelId/reqId/workspaceId 继承父`；collab 元数据继承（rootId/chain 更新） | 父 WU 无 collab -> 子 WU 创建 `collab={ rootId:父id, depth:1, chain:[reviewer.profileId], delegationCount:0 }` | 不触发 DelegationGate（系统代派不是 agent 主动 DELEGATE） |
| AC-4.4 | reviewer 角色的 AgentLoop 认领子 WU 并执行 | 子 WU 创建后 | reviewer.loop claim -> agentStep；prompt 注入 code-review skill（通过 `skillLoader.load({ agentType: 'reviewer' })`，已在 review-agent.service.ts:89 验证）+ 父 WU diff context | reviewer 角色未 mount（provider 未配） -> 子 WU 保持 unassigned，由 workunit-timeout 释放 | - |
| AC-4.5 | reviewer 输出 COMPLETE -> 系统调 `workunit.reviewPassed(父id)` 或 `reviewRejected(父id, reason)` | reviewer.stepResult.action='complete' 时 | 解析 reviewer 输出（review report summary），approved=true -> 父 in_review->done；approved=false -> 父 in_review->active + 写 `metadata.reviewFeedback` | reviewer 输出格式不规范 -> 默认 reviewRejected + reason="reviewer output unparseable" | 不自动循环（reject 后父 WU 回到 active 由原 agent 处理） |
| AC-4.6 | 旧 `reviewAgent.review()` 不再被新代码调用 | 重构后 | `grep "reviewAgent\.review\b" apps/api/src/` -> 0 matches（保留 `reviewDiff` 用于手动 API） | `routes.ts:154 reviewAgent.reviewDiff` 保留（手动 API） | review-agent.service.ts 内部 spawn 模式作为 fallback 保留至 AC Group 7 |
| AC-4.7 | reviewer 角色搭配 code-review skill 验证 | reviewer 角色 claim 子 WU 时 | `skillLoader.load({ agentType: 'reviewer' })` 返回的 skill 列表含 `code-review`；prompt 含 skill 段 | skill 未安装 -> 警告 log，不阻塞（reviewer 仍可基于 prompt 审查） | - |
| AC-4.8 | `ReviewDispatcher` 有对应测试 | 测试创建后 | `review-dispatcher.test.ts` 覆盖：有 reviewer 角色触发创建、无 reviewer 跳过、reviewer 输出 complete+approved、reviewer 输出 complete+rejected、reviewer 输出格式异常 | - | - |

**不做**：不强制 reviewer 角色必须存在（无 reviewer 时保持现状，等人手动审查）。不迁移 `reviewAgent.reviewDiff` 手动 API（保留）。

---

## AC Group 5: A2A P2 预算闸门 + 树聚合只读接口 + 树状开销 UI

**covers**: [S-17, S-18, S-19, S-20, S-21]

**目标**：接通 P1 留桩的预算闸门，放开深度到 2；新增树聚合只读接口和 UI。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-5.1 | `checkTreeBudget(rootId, fileStore)` 实现 | 重构后 | 读取 studio-events.jsonl 按 `workUnitId in <rootId 子树>` 聚合 executionTokens 总和；`tree已耗 + 子 WU 预估(=0) ≤ TREE_TOKEN_BUDGET=400K` -> pass；超出 -> `{ pass: false, reason: '协作树预算超限（已耗 X / 上限 400000）' }` | studio-events.jsonl 不存在 -> 总和=0，pass | 子 WU 预估暂取 0（无先验数据），TODO 注释标注后续可基于历史 |
| AC-5.2 | `checkDelegation` 第 8 步调用 `checkTreeBudget(rootId)` | 重构后 | delegation-gate.ts:155 调用新签名；返回 fail -> 拒绝创建子 WU，reason 进入 NEED_INPUT 卡片 | - | - |
| AC-5.3 | `STUDIO_COLLAB_MAX_DEPTH` 默认值改为 2 | 重构后 | `resolveMaxDepth()` 默认返回 2（env 覆盖 1-3） | env 显式设 1 -> 仍按 1 | - |
| AC-5.4 | `GET /api/v1/workunits/:id/tree-tokens` 接口存在 | 接口创建后 | 响应 `{ rootId, nodes: [{ workUnitId, profileName, status, injectedTokens, executionTokens, totalTokens }], rootTotal, budgetRemaining }` | wuId 不存在 -> 404；wu 无 collab -> 返回单节点（自身） | - |
| AC-5.5 | `token-usage.service.ts` 新增 `aggregateTreeTokens(rootId)` 方法 | 重构后 | 读取 studio-events.jsonl 按 rootId 子树聚合；返回 `TreeTokenReport` | 文件不存在 -> 返回零值报告 | 复用现有读取逻辑 |
| AC-5.6 | 父 WU 详情页右侧抽屉显示树状开销视图 | 前端添加后 | 每节点一行：profile name + status + injected/execution tokens；根部一行合计 + 距 TREE_TOKEN_BUDGET 余量进度条 | 单节点 WU -> 抽屉显示"无协作树" | - |
| AC-5.7 | delegate 卡片（NEED_INPUT）显示"树开销 x/预算" | 前端添加后 | 卡片底部一行："树开销 12345 / 400000 tokens" | 父 WU 无 token 数据 -> 显示 "树开销 0 / 400000 tokens" | - |
| AC-5.8 | 预算闸门 + 树聚合接口有测试 | 测试创建后 | `delegation-gate.test.ts` 新增预算超限用例；`token-usage.service.test.ts` 新增 aggregateTreeTokens 用例 | - | - |

**不做**：不实现子 WU 预估（取 0）。不实现预算超限自动降级（人审 NEED_INPUT）。

---

## AC Group 6: A2A P2 频道默认管线 + skill 降级通路

**covers**: [S-22, S-23]

**目标**：频道默认管线展开为父子 WU 树；skill 降级通路接通人审。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-6.1 | `ChannelData.defaultPipeline` 字段存在 | schema 扩展后 | `file-store.ts:ChannelData` 含 `defaultPipeline?: string[]`；序列化 channels.json 包含此字段 | 无 defaultPipeline -> undefined，不触发展开 | 不破坏现有 channel 数据 |
| AC-6.2 | `POST /api/v1/channels/:id` 支持配置 `defaultPipeline` | 接口扩展后 | body 含 `defaultPipeline: ['design','plan','implement','review']` 时持久化；校验每项是已存在的 AgentProfile name | 名称不存在 -> 400 拒绝 | - |
| AC-6.3 | feature 类 WorkUnit（type='feature'）创建时若频道有 defaultPipeline -> 自动展开为父子树 | WorkUnit 创建后 | 第一跳由代码发起：父 WU type='feature' -> 创建 type='design' 子 WU 作为链头；后续跳由 agent DELEGATE 触发（复用 §4 机制） | pipeline 长度=1 -> 单 WU 不展开；频道无 defaultPipeline -> 不展开 | 不改 WorkUnit 状态机 |
| AC-6.4 | `skill-demotion.ts:DemotionProposalStore` 接通人审通道 | 重构后 | 新增 `approve(proposalId)` / `reject(proposalId)` 方法；approve -> 写 skill SKILL.md frontmatter `status: archived` + 移动到 `_deprecated/` 目录 | skill 文件不存在 -> approve 失败，proposal 标 `error` | 不自动执行降级（必须人审） |
| AC-6.5 | 新增 `POST /api/v1/skills/demotion-proposals/:id/approve` 和 `/reject` 接口 | 接口创建后 | 调用 DemotionProposalStore；返回更新后 proposal | proposal 已 approved/rejected -> 400 | - |
| AC-6.6 | 构造零使用率 skill -> 触发降级提案 -> 人审批准后 status 变 archived 的 e2e 测试 | 测试创建后 | 测试步骤：1) 创建 mock skill 文件；2) 运行 `scanDemotionProposals`；3) 检查 proposals.json 含 pending；4) 调 approve；5) 检查 SKILL.md frontmatter `status: archived` + 文件移动到 `_deprecated/` | - | - |

**不做**：不实现 L1/L2 分层审查（规划文档 §3.3 排除）。不自动降级。

---

## AC Group 7: 废弃代码清理 + 文档更新

**covers**: [S-24, S-25, S-26, S-27, S-28, S-29]

**目标**：迁移完成后删除旧架构产物。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-7.1 | `packages/studio-shared/src/llm/model-gateway.ts` 不存在 | 删除后 | `ls` -> not found | - | - |
| AC-7.2 | `packages/studio-shared/src/llm/provider-registry.ts` 不存在 | 删除后 | `ls` -> not found | - | - |
| AC-7.3 | `packages/studio-shared/src/llm/model-router.ts` 不存在 | 删除后 | `ls` -> not found | - | - |
| AC-7.4 | `packages/studio-shared/src/llm/usage-tracker.ts` 不存在 | 删除后 | `ls` -> not found | - | - |
| AC-7.5 | `packages/studio-shared/src/llm/spawn-claude-cli.ts` 不存在 | 删除后 | `ls` -> not found；`grep "buildSpawnEnv" packages/studio-shared/src/` -> 0 matches | - | - |
| AC-7.6 | `packages/studio-shared/src/llm/index.ts` 不再 export `ModelGateway`/`modelGateway`/`buildSpawnEnv` | 重构后 | `grep "ModelGateway\|modelGateway\|buildSpawnEnv" packages/studio-shared/src/llm/index.ts` -> 0 matches | - | 保留 `LLMClient`/`llmClient`（仍有消费者，单独排期） |
| AC-7.7 | `apps/api/src/` 全量 `grep "STUDIO_API_KEY\|PIPELINE_API_KEY\|KNOWLEDGE_API_KEY\|STUDIO_BASE_URL\|PIPELINE_BASE_URL\|KNOWLEDGE_BASE_URL"` -> 0 matches（不含 dist/） | 删除后 | grep 命令输出空 | `cli/config.ts` 的 managed keys 列表同步移除 | 测试文件允许保留对 env 变量的 setup/teardown（不在生产代码） |
| AC-7.8 | `index.ts:69 modelGateway.loadFromEnv()` 调用删除 | 重构后 | grep `loadFromEnv` apps/api/src/index.ts -> 0 matches | - | - |
| AC-7.9 | `index.ts:71-83 KNOWLEDGE_API_KEY` provider 注册块删除 | 重构后 | grep `KNOWLEDGE_API_KEY` index.ts -> 0 matches | - | - |
| AC-7.10 | `modules/llm/config.service.ts` 不再读 `STUDIO_API_KEY` | 重构后 | grep `STUDIO_API_KEY` config.service.ts -> 0 matches | - | 配置 service 本身保留（用于 LLMClient 配置） |
| AC-7.11 | `modules/llm/proxy.ts` 删除（仅用 STUDIO_API_KEY） | 删除后 | `ls` -> not found；routes 引用同步清理 | - | - |
| AC-7.12 | `modules/knowledge/internal.routes.ts:126` 不再读 `KNOWLEDGE_API_KEY` | 重构后 | grep `KNOWLEDGE_API_KEY` internal.routes.ts -> 0 matches | - | - |
| AC-7.13 | `packages/studio-shared/src/config/getProviderApiKey.ts` 不存在 | 删除后 | `ls` -> not found；`__tests__/getProviderApiKey.test.ts` 同步删除 | - | - |
| AC-7.14 | `packages/studio-shared/src/config/` 不再 export `PROVIDER_KEY_MAP`/`getProviderApiKey`/`WorkloadType` | 重构后 | grep `PROVIDER_KEY_MAP\|getProviderApiKey\|WorkloadType` packages/studio-shared/src/config/ -> 0 matches | - | - |
| AC-7.15 | `~/.claude/settings-deepseek.json` 不含 `STUDIO_API_KEY` 明文 | 清理后 | `grep "STUDIO_API_KEY\|sk-3d3f905" ~/.claude/settings-deepseek.json` -> 0 matches | 文件保留（其他配置仍需），只移除明文 key | 不删 settings-deepseek.json 文件 |
| AC-7.16 | `docs/plans/2026-07-agent-to-agent-collab-design.md §10.1` 第 8 条"双轨架构"更新 | 文档更新后 | 文本描述飞轮闭环走 studio 角色，不再 hub 直连全局 key；旧描述标注 `[已更新 2026-07-XX]` | - | - |
| AC-7.17 | `apps/api/src/modules/agents/review-agent.service.ts` 中 4 处 `buildSpawnEnv` 调用移除 | 重构后 | grep `buildSpawnEnv` review-agent.service.ts -> 0 matches；review-agent 只保留 `reviewDiff` 手动 API | - | review-agent.service.ts 本身保留（reviewDiff 仍用） |
| AC-7.18 | `packages/studio-agent/src/services/runner-params.ts` + `session-manager.ts` 中 `buildSpawnEnv` 调用移除 | 重构后 | grep `buildSpawnEnv` packages/studio-agent/src/ -> 0 matches | - | - |
| AC-7.19 | 删除后全量测试通过 | 全部清理后 | `pnpm test` 全部通过；`pnpm run build` 成功 | - | dist/ 不检查 |
| AC-7.20 | CAPABILITIES.md 同步更新 | 文档同步后 | `grep "modelGateway\|buildSpawnEnv" CAPABILITIES.md` -> 0 matches；新增 systemExecutor 条目 | - | - |

**不做**：不删除 `LLMClient`/`llmClient`（不在本次范围）。不删除 `llm-client.ts`。

---

## AC Group 8: RemoteExecutor

**covers**: [S-30, S-31]

**目标**：支持远程节点执行 AgentTask。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-8.1 | `RemoteExecutor` class 存在于 `apps/api/src/modules/agents/remote-executor.ts` | 新建文件后 | `ls` 确认；实现 `Executor` 接口；`execute(task)` 路由到 `task.nodeId` 对应节点的任务通道 | - | - |
| AC-8.2 | `AgentTask` 新增 `nodeId?: string` 字段（默认 'local'） | schema 扩展后 | type 定义同步；`profile.nodeId === 'local'` 或 undefined -> LocalExecutor；否则 RemoteExecutor | - | - |
| AC-8.3 | `AgentProfileData` 新增 `nodeId?: string` 字段 | schema 扩展后 | file-store.ts:AgentProfileData 含 nodeId；序列化 profiles.json 包含 | 现有 profile 无 nodeId -> 视为 'local' | - |
| AC-8.4 | daemon 协议新增 `agent-task` 消息类型 | 协议扩展后 | server -> daemon 发 `{ type: 'agent-task', task: AgentTask }`；daemon -> server 回 `{ type: 'agent-task-result', executionId, result: ExecutionResult }` | 节点离线 -> 30s 超时 -> 抛 `RemoteNodeUnreachableError` | - |
| AC-8.5 | `task-executor.ts` 接收 `agent-task` 后调 `agentRunner.executeLightweight(task)` 执行 | daemon 端实现后 | 结果回传 server；写 `workunit:tokens` 事件到节点本地 studio-events.jsonl | - | - |
| AC-8.6 | `AgentLoop` 构造时根据 `profile.nodeId` 选择 Executor | 重构后 | `new AgentLoop(profile)` 内部：`nodeId === 'local' ? new LocalExecutor() : new RemoteExecutor(nodeId)` | - | - |
| AC-8.7 | 节点心跳超时（5min）-> profile 显示离线 | 监控扫描后 | `agentProfile.list` 返回 `isOnline: false`；`lastError: 'node offline'` | - | 复用 agent-timeout-scan trigger |
| AC-8.8 | 节点离线时已 claim WU 由 workunit-timeout 释放 | 超时扫描后 | 现有 `workunit-timeout` trigger 释放超时 claim（无需改动） | - | - |
| AC-8.9 | `RemoteExecutor` 有对应测试 | 测试创建后 | `remote-executor.test.ts` 覆盖：节点在线任务路由、节点离线超时、结果回传 | - | 不要求 e2e 跨节点测试 |

**不做**：不做跨频道委派（规划文档 §3.3 排除）。不做 DM 协作通道。

---

## 全局验收（来自规划文档 §7）

| 规划 AC # | 对应 SDD AC | 验证方法 |
|-----------|------------|---------|
| 1 | AC-7.7 | `grep -r "STUDIO_API_KEY\|PIPELINE_API_KEY\|KNOWLEDGE_API_KEY" apps/ packages/`（除 dist/）无结果 |
| 2 | AC-3.9 | `grep -r "modelGateway\.prompt\|modelGateway\.promptJson" apps/api/src/` 无结果 |
| 3 | AC-1.1 ~ AC-1.5 | studio 角色存在/不可删/provider 可配/不 mount/不显示 |
| 4 | AC-3.1 ~ AC-3.7 | systemExecutor 封装 10 处迁移 |
| 5 | AC-4.1 ~ AC-4.5 | review 走系统代派 |
| 6 | AC-4.2 | 无 reviewer 保持 in_review |
| 7 | AC-7.5 | `buildSpawnEnv` / `spawn-claude-cli.ts` 已删除 |
| 8 | AC-7.15 | `settings-deepseek.json` 不含明文 key |
| 9 | AC-5.1 ~ AC-5.3 | 预算闸门接通，深度 2 |
| 10 | AC-5.4 ~ AC-5.7 | 树聚合接口 + UI 可见 |
| 11 | AC-6.4 ~ AC-6.6 | skill 降级通路 |
| 12 | AC-8.1 ~ AC-8.9 | RemoteExecutor |
| 13 | AC-2.5 | 角色初始化向导 |

---

## 非目标（来自规划文档 §3.3）

- agent-loop 本身的执行模型（spawn per step vs 常驻交互）-- Claude CLI 限制
- agent->agent 协作的 P3 深化（跨频道委派 / L2 审查分层 / DM）
- 2K 注入硬截断（injectContext 的 maxTokens 做实）-- 属飞轮修复范围
- `LLMClient`/`llmClient` 删除（单独排期）
