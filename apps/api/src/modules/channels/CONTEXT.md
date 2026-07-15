# channels

> 此文件描述 apps/api/src/modules/channels 目录的职责和上下文

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/discovery-exposure.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/channel.routes.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-prompt.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-prompt.ts, apps/api/src/modules/channels/analyst-trigger.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/requirements-doc.routes.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/channel.routes.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/contract-test-validator.ts, apps/api/src/modules/channels/analyst-prompt.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/analyst-executor.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/CONTEXT.md, apps/api/src/modules/channels/analyst-executor.ts, apps/api/src/modules/channels/analyst-trigger.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/channel-init.ts, apps/api/src/modules/channels/channel-message.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/convert-to-task.service.ts, apps/api/src/modules/channels/discovery-exposure.service.ts, apps/api/src/modules/channels/message-routing.ts, apps/api/src/modules/channels/requirements-doc.routes.ts, apps/api/src/modules/channels/acgroup-tier.ts, apps/api/src/modules/channels/analyst-executor.ts, apps/api/src/modules/channels/analyst-fact-verification.ts, apps/api/src/modules/channels/analyst-knowledge.ts, apps/api/src/modules/channels/analyst-prescan.ts, apps/api/src/modules/channels/analyst-prompt.ts, apps/api/src/modules/channels/analyst-scout.ts, apps/api/src/modules/channels/analyst-synthesizer.ts, apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/contract-test-red-check.ts, apps/api/src/modules/channels/contract-test-validator.ts, apps/api/src/modules/channels/conversation-converter.ts, apps/api/src/modules/channels/conversation-handler.ts, apps/api/src/modules/channels/multi-repo-split.ts, apps/api/src/modules/channels/sdd-verification.ts, apps/api/src/modules/channels/CONTEXT.md

<!-- STALE_SINCE: 2026-07-15 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/channels/channel-init.ts, apps/api/src/modules/channels/channel-message.service.ts, apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/convert-to-task.service.ts, apps/api/src/modules/channels/discovery-exposure.service.ts, apps/api/src/modules/channels/message-routing.ts, apps/api/src/modules/channels/requirements-doc.routes.ts, apps/api/src/modules/channels/acgroup-tier.ts, apps/api/src/modules/channels/analyst-executor.ts, apps/api/src/modules/channels/analyst-fact-verification.ts, apps/api/src/modules/channels/analyst-knowledge.ts, apps/api/src/modules/channels/analyst-prescan.ts, apps/api/src/modules/channels/analyst-prompt.ts, apps/api/src/modules/channels/analyst-scout.ts, apps/api/src/modules/channels/analyst-synthesizer.ts, apps/api/src/modules/channels/analyst-trigger.service.ts, apps/api/src/modules/channels/contract-test-red-check.ts, apps/api/src/modules/channels/contract-test-validator.ts, apps/api/src/modules/channels/conversation-converter.ts, apps/api/src/modules/channels/conversation-handler.ts, apps/api/src/modules/channels/multi-repo-split.ts, apps/api/src/modules/channels/sdd-verification.ts, apps/api/src/modules/channels/CONTEXT.md

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
| requirement-gate.ts | `requirementGate()` | AC 结构验证 + 文件冲突检查 + architectureContext 质量门 |
| discovery-exposure.service.ts | `discoveryExposure.expose()` | Analyst/Reviewer 发现统一曝光到 #系统 |
| channel.routes.ts | Express router | Channel API 端点（消息/start_execution/cancel 等） |
| requirements-doc.routes.ts | Express router | RequirementsDoc CRUD 端点 |

## 依赖关系

**本模块依赖**：
- `@dommaker/studio-prisma` — DB（RequirementsDoc / GoalExecution / Channel 等）
- `@dommaker/studio-shared` — logger, modelGateway, eventBus, toKebab, writeSddDoc
- `daemon/studio-daemon` — Claude Code session 管理（submitAdhocJob）
- `agents/requirement-gate` — 质量门验证
- `agents/monitor-agent` — 管线监控

**被依赖**：
- `cli/studio-cli.ts` — CLI 入口调用 trigger()

## 注意事项

- **输出文件路径**：`perInvocationOutputFile()` 返回绝对路径（ANALYST_DIR 基于 REPO_DIR）。scout 路径用相对路径，session-manager 有 worktree fallback
- **JSON 解析链**：4 层（sanitize → code-fence → regex → LLM repair），outputText = "DONE" 无 JSON，文件是唯一数据载体
- **DB 去重**：同 channel 24h 内有有效 RequirementsDoc → 质量门验证 → 直接复用（0 token）
- **requirement-gate Stage 2**：确定性检查（文件重叠/单向依赖/architectureContext），全部 soft warning，永不阻断
- **outputFile 唯一性**：Claude 通过 Write tool 写文件，stdout 只有 "DONE"。文件丢失 = 数据丢失

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `8d6820d3`: ChannelWorkspaceSetting calling wrong API (404)
- ✅ `c3b1aab8`: channel-an): resolve 7 code review warnings
- ✅ `ab28f573`: pipeline-removal): code review warnings — dead scope configs + pipeline-dashboard deletion
- ✅ B56: 清理 knowledge.md 死链路 — 删 loadKnowledge/saveKnowledge/selectRelevantSections/KNOWLEDGE_FILE（零调用方），trigger 不再写文件，scout/analyst prompt 指向 KnowledgeStore/MCP search
- ✅ `5797f5f5`: restore CONTEXT.md stale warnings, only append fix entry
- ✅ `e0685c3d`: pipeline output resilience + DB dedup (0 token reuse) — worktree fallback + path resolution + quality-gated dedup
- ✅ `f7ddf542`: pipeline LLM output resilience — JSON sanitize + deterministic gate
- ✅ `0fbbc2ef`: B55 管线 Session 隔离 + Analyst 健壮性 + SDD 清理
- ✅ `66228b3f`: architectureContext 质量闭环 — 统一 Analyst 产出 + 修正 Gate 检查层
- ✅ `a15515d6`: ContractTest 质量保障 — 4层验证(AC Coverage/TS Syntax/Import Path/RED) + Revision闭环 + 5 CT监控点
- ✅ `732e6396`: 补全 12 监控点数据缺口 — 支撑 O2-KR2 缓存优化决策
- ✅ `1c4ac168`: SP-004): 补齐 SDD 三个缺口 — Files section + Analyst 输出 + 去 DB 读
- ✅ `3281bd80`: P6.5): Skill 元数据注入合规 + MCP SSE transport + fileKnowledge 移除
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `9dec006c`: 管线自举根因修复 — AC 质量 + Gate 加固 + OKR v3
- ✅ `7ab11eb8`: knowledge sync pipeline — auto-sync to vector DB after ingest
- ✅ `4fbb26ac`: Analyst prompt 加 fast tier 验证性探索规则
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `a88bccd6`: tsc-gate surgical baseline update + fix 13 pre-existing TS errors
- ✅ `7d5b0fda`: Phase 0 — 7 Critical bugs in pipeline quality gates and concurrency
