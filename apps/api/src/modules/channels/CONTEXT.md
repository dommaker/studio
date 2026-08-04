# channels

> 此文件描述 apps/api/src/modules/channels 目录的职责和上下文

## 职责

Channel 驱动管线入口：@Analyst 触发 → RequirementsDoc 生成 → Goal 创建 → 执行管线。
包含 Analyst 全流程（scout+synth / direct 两条路径）、ContractTest 验证、SDD 文件写入。

## 核心导出

| 模块 | 导出 | 职责 |
|------|------|------|
| analyst-trigger.service.ts | `AnalystTriggerService.trigger()` | 管线入口：DB 去重 → LLM 分析 → 验证 → SDD → 卡片 → 自动执行 |
| analyst-executor.ts | `runClaudeCode()`, `sanitizeJson()`, `validateAnalystOutput()` | Claude Code 执行 + 4 层 JSON 解析链 + 输出验证 |
| analyst-knowledge.ts | `perInvocationOutputFile()`, `loadKnowledge()`, `saveKnowledge()` | Analyst 输出路径 + knowledge.md 读写 |
| analyst-prompt.ts | `buildAnalystPrompt()`, `buildRevisionPrompt()` | Analyst prompt 构建（含 scout/synth/revision） |
| channel-message.service.ts | `channelMessageService` | 消息创建/更新/删除 + event 发布 |
| contract-test-validator.ts | `validateContractTests()` | Layer 1-3 契约测试质量检查（AC coverage / TS syntax / import path） |
| contract-test-red-check.ts | `verifyRedState()` | Layer 4 RED 状态验证 |
| discovery-exposure.service.ts | `discoveryExposure.expose()` | Analyst/Reviewer 发现统一曝光到 #系统 |
| channel.routes.ts | Express router | Channel API 端点（消息/start_execution/cancel 等） |
| requirements-doc.routes.ts | Express router | RequirementsDoc CRUD 端点 |

## 依赖关系

**本模块依赖**：
- `@dommaker/studio-shared` — FileStore（Channel / RequirementsDoc 等文件存储，已替代 studio-prisma DB）, logger, modelGateway, eventBus, toKebab, writeSddDoc
- `agents/monitor-agent` — 管线监控

**被依赖**：
- `cli/studio-cli.ts` — CLI 入口调用 trigger()

## 注意事项

- **输出文件路径**：`perInvocationOutputFile()` 返回绝对路径（ANALYST_DIR 基于 REPO_DIR）。scout 路径用相对路径，session-manager 有 worktree fallback
- **JSON 解析链**：4 层（sanitize → code-fence → regex → LLM repair），outputText = "DONE" 无 JSON，文件是唯一数据载体
- **DB 去重**：同 channel 24h 内有有效 RequirementsDoc → 直接复用（0 token）
- **outputFile 唯一性**：Claude 通过 Write tool 写文件，stdout 只有 "DONE"。文件丢失 = 数据丢失
- **鉴权分层（2026-07-24 收紧，姿态 A）**：`/api/v1/channels` 在 PUBLIC_API —— GET（`/`、`/:id`、`/:id/messages`）保持**匿名公开**（Lurk Wall 围观本体，不要再给 GET 加中间件）；9 条写端点（建频道/发消息/删频道/archive/restore/PATCH/members/convert-to-task×2）= `requireAuth()+requireNotGuest()`。注意 `POST /:id/messages` 经 @mention 派单/恢复挂起 WU 可直接触发 agent 执行与 LLM 消耗，是收紧前最危险的匿名入口。requirements-docs PUT 同为 requireNotGuest
- **消息路由优先级**（`message-routing.ts` routeMessage）：`replyToId` 线程回复（继承父消息 workUnitId）→ `@mention` 派单（建 WorkUnit，`metadata.creationMode='mention'`；§9.5 只匹配本频道 members，members 为空回退全量 active profile）→ 纯文本仅存储。mention = 纯文本 `@name`（无结构化 id），检测与 scope 剥离用 Unicode 正则 `[\p{L}\p{N}_-]+/u`；手打中文连写无空格（`@开发你好`）匹配不到——前端补全插入带尾随空格，主路径不受影响
- **成员绑定**：`channel.members`（config.json 内 JSON 字符串数组）是成员关系唯一事实源，`AgentProfile.channels` 已废弃（启动时幂等迁移）；PATCH `/:id/members` 合并 add/remove 后整体回写；删除 profile 时由 AgentProfileService 反向清理各频道 members 悬空引用
