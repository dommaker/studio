---
id: "pmo-channel-agent-flow"
slug: "pmo-channel-agent-flow"
title: "PMO → Channel → Agent 流程串联"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["pmo", "agent-network", "trigger", "workunit", "sdd-index", "event-driven"]
createdAt: "2026-07-06"
updatedAt: "2026-07-06"
---

# PMO → Channel → Agent 流程串联

把用户需求从 PMO 立项，经 Channel 发布，到 Agent 自动发现并执行的全链路打通。补齐 Trigger EVENT 条件，回归 AS-025 事件驱动设计。

## 背景

设计文档：`~/.claude/projects/-root-projects/memory/design_pmo_workunit_sdd_architecture.md`

当前断点：
- AgentLoop 纯轮询（15s），无事件驱动
- Trigger Registry 只实现 SCHEDULE，EVENT 条件缺失
- PMO 无发布到 Channel 的入口
- Agent 无 MCP tool 创建下游 WorkUnit
- SDD 无索引，无法通过 pmoNumber 反查 SDD

## AC Groups

### AC-1: Trigger EVENT 条件类型扩展

covers: 源项目 1（Trigger EVENT condition type extension）

#### 验收标准

- [ ] `TriggerCondition` 联合类型新增 `{ type: 'EVENT'; event: string; filter?: Record<string, unknown> }`
- [ ] 类型定义导出可被其他模块 import
- [ ] 现有 SCHEDULE 条件不受影响（向后兼容）
- [ ] TypeScript 编译无错误

#### 边界情况

- `event` 为空字符串 → 类型层面不限制，运行时 TriggerScheduler 校验
- `filter` 为 undefined → 表示匹配该 event 的所有 payload

#### 不做

- 不实现其他条件类型（STATE_CHANGE/PATTERN/THRESHOLD 留到后续）
- 不修改 TriggerStore 存储格式

---

### AC-2: TriggerScheduler EventBus 集成

covers: 源项目 2（TriggerScheduler EventBus subscription）

#### 验收标准

- [ ] TriggerScheduler 构造函数接受 `eventBus: StudioEventBus` 参数
- [ ] `registerTrigger()` 遇到 EVENT 条件时，自动 `eventBus.subscribe(event, handler)`
- [ ] 事件到达时匹配 filter（如有），匹配成功则执行 action
- [ ] 事件→action 执行延迟 < 100ms
- [ ] Trigger 被移除/禁用时取消对应 EventBus 订阅（防内存泄漏）
- [ ] 现有 SCHEDULE tick 逻辑不受影响
- [ ] 所有现有 trigger-scheduler 测试通过

#### 边界情况

- 同一 event 注册多个 trigger → 每个 trigger 独立触发
- filter 部分匹配 → 不触发
- eventBus 未注入（旧调用方）→ 构造函数兼容（eventBus 可选或提供默认值）
- trigger disabled 时事件到达 → 跳过不执行

#### 不做

- 不实现事件持久化（内存 EventBus 足够）
- 不实现事件重试

---

### AC-3: AgentLoop EVENT trigger 注册

covers: 源项目 3（AgentLoop EVENT trigger registration）

#### 验收标准

- [ ] AgentLoop 启动时注册 EVENT trigger：`workunit.created`
- [ ] 事件触发时调用 `observe()` 方法（复用现有 observe 逻辑）
- [ ] 保留 SCHEDULE 轮询兜底（30s 间隔）
- [ ] AgentLoop 停止时取消 trigger 注册 + 清理 EventBus 订阅
- [ ] 事件触发 observe 与轮询触发 observe 不冲突（幂等）

#### 边界情况

- AgentLoop 未启动时收到事件 → 忽略（trigger 未注册）
- 多个 AgentLoop 实例 → 每个独立注册，各自 observe
- 事件触发 observe 正在执行时轮询也触发 → observe 内部 claim 乐观锁防重

#### 不做

- 不删除轮询（保留兜底）
- 不修改 observe() 内部逻辑

---

### AC-4: WorkUnit 创建事件发布

covers: 源项目 4（WorkUnit creation event trigger）

#### 验收标准

- [ ] `WorkUnitService.create()` 成功后发布 `workunit.created` 事件
- [ ] 事件 payload 包含 `{ workunit: WorkUnit }`
- [ ] 事件发布在 DB 写入之后（先落库再发事件）
- [ ] 现有 create 返回值不变
- [ ] 现有 WorkUnit 测试全部通过

#### 边界情况

- DB 写入失败 → 不发事件
- eventBus.publish 抛异常 → catch 并 log，不影响 create 返回

#### 不做

- 不在 claim/status change 时发事件（后续按需扩展）

---

### AC-5: PMO 发布 API

covers: 源项目 5（PMO publish API）

#### 验收标准

- [ ] `POST /api/v1/pmo/project/:id/publish` 端点存在
- [ ] 请求体：`{ channelId: string }`
- [ ] 创建 ChannelMessage（content = PMO title + requirement 摘要，meta 含 pmoId）
- [ ] 创建分析 WorkUnit（type=analysis, scope 描述 PMO 需求, metadata.pmold）
- [ ] PMO 状态 pending → active
- [ ] 返回 `{ message: ChannelMessage, workUnit: WorkUnit }`
- [ ] 非 pending 状态 PMO → 400 错误

#### 边界情况

- PMO 已发布（status=active）→ 400
- channelId 不存在 → 400
- PMO requirement 为空 → 仍可发布（ChannelMessage content 只用 title）
- 并发发布 → 乐观状态检查防重

#### 不做

- 不实现发布到多个 Channel
- 不实现撤回发布

---

### AC-6: PMO UI 发布按钮

covers: 源项目 6（PMO UI publish button）

#### 验收标准

- [ ] PMO 列表/详情页有"发布"按钮
- [ ] 仅 pending 状态显示按钮
- [ ] 点击弹出 Channel 选择（下拉，列出可用 Channel）
- [ ] 确认后调用 `POST /api/v1/pmo/project/:id/publish`
- [ ] 成功后刷新 PMO 状态显示

#### 边界情况

- 无可用 Channel → 按钮禁用 + tooltip 提示
- API 调用失败 → 显示错误信息

#### 不做

- 不实现发布后实时推送更新
- 不实现批量发布

---

### AC-7: MCP tool createWorkUnit

covers: 源项目 7（MCP tool createWorkUnit）

#### 验收标准

- [ ] tool name: `createWorkUnit`
- [ ] inputSchema: type(enum), scope(required), channelId(optional), metadata(optional)
- [ ] handler 调用 WorkUnitService.create()（不直接 prisma，复用状态机验证）
- [ ] 返回 `{ workUnitId, type, scope, status }`
- [ ] tool 注册到 toolRegistry，riskLevel = medium

#### 边界情况

- type 不在 enum 范围 → 验证错误
- scope 为空 → 验证错误

#### 不做

- 不实现 WorkUnit 更新的 MCP tool（后续按需）

---

### AC-8: SDD frontmatter 加 pmoNumber

covers: 源项目 8（SDD frontmatter pmoNumber field）

#### 验收标准

- [ ] SDD 标准 frontmatter 文档更新：新增 `pmoNumber` 字段（可选，格式 PM-NNN）
- [ ] task-planner Skill 写 SDD 时支持填入 pmoNumber
- [ ] 现有 SDD 无 pmoNumber 字段 → 索引生成时该列留空
- [ ] 不影响现有 SDD 的其他 frontmatter 字段

#### 边界情况

- pmoNumber 对应的 PMO 不存在 → 不校验（松关联）
- 多个 SDD 引用同一 pmoNumber → 允许（索引多条）

#### 不做

- 不强制所有 SDD 补 pmoNumber
- 不校验 pmoNumber 格式

---

### AC-9: SDD 索引生成器

covers: 源项目 9（SDD index generator）

#### 验收标准

- [ ] 扫描 `docs/sdd/*/requirement.md`，解析 frontmatter
- [ ] 生成 `docs/sdd/_index.md`
- [ ] 格式：`slug|pmoNumber|status|title|tags`
- [ ] pipe 分隔符，tags 用逗号分隔
- [ ] header 注释含总条目数、生成命令、使用说明
- [ ] CLI 命令：`harness sdd index`
- [ ] 跳过无 requirement.md 的目录
- [ ] 跳过 status: stale 的 SDD（不出现在索引中）

#### 边界情况

- SDD 无 frontmatter → best-effort 从文件名推断 slug，status 标记 unknown
- SDD 无 pmoNumber → 该列留空
- SDD 无 tags → 该列留空
- docs/sdd/ 不存在 → 报错提示

#### 不做

- 不索引 design.md/task.md（只索引 requirement.md）
- 不实现增量更新（每次全量重建）

---

### AC-10: PMO-SDD 关联查询 API

covers: 源项目 10（PMO-SDD association query API）

#### 验收标准

- [ ] `GET /api/v1/pmo/project/:id/sdd` 端点存在
- [ ] 读 PMO 获取 pmoNumber → grep SDD 索引 → 返回匹配条目
- [ ] 返回格式：`{ sddEntries: [{ slug, pmoNumber, status, title, tags }] }`
- [ ] 无关联 SDD → 返回空数组 `{ sddEntries: [] }`

#### 边界情况

- SDD 索引文件不存在 → 返回空数组 + 日志警告
- PMO 不存在 → 404

#### 不做

- 不实现反向查询（SDD → PMO）
- 不实现 SDD 内容读取返回

---

## 源项目追溯表

| # | 源项目 | 产出类型 | SDD AC |
|---|--------|---------|--------|
| 1 | Trigger EVENT condition type extension | 代码扩展 | AC-1 |
| 2 | TriggerScheduler EventBus subscription | 代码扩展 | AC-2 |
| 3 | AgentLoop EVENT trigger registration | 代码扩展 | AC-3 |
| 4 | WorkUnit creation event trigger | 代码扩展 | AC-4 |
| 5 | PMO publish API | 新 API | AC-5 |
| 6 | PMO UI publish button | 前端 UI | AC-6 |
| 7 | MCP tool createWorkUnit | 新 MCP tool | AC-7 |
| 8 | SDD frontmatter pmoNumber | 标准扩展 + Skill 更新 | AC-8 |
| 9 | SDD index generator | 新模块 + CLI | AC-9 |
| 10 | PMO-SDD association query API | 新 API | AC-10 |
