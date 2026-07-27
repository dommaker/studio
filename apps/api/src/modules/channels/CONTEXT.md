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
| requirement-gate.ts | `requirementGate()` | AC 结构验证 + 文件冲突检查 + architectureContext 质量门 |
| discovery-exposure.service.ts | `discoveryExposure.expose()` | Analyst/Reviewer 发现统一曝光到 #系统 |
| channel.routes.ts | Express router | Channel API 端点（消息/start_execution/cancel 等） |
| requirements-doc.routes.ts | Express router | RequirementsDoc CRUD 端点 |

## 依赖关系

**本模块依赖**：
- `@dommaker/studio-shared` — FileStore（Channel / RequirementsDoc 等文件存储，已替代 studio-prisma DB）, logger, modelGateway, eventBus, toKebab, writeSddDoc
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
- **鉴权分层（2026-07-24 收紧，姿态 A）**：`/api/v1/channels` 在 PUBLIC_API —— GET（`/`、`/:id`、`/:id/messages`）保持**匿名公开**（Lurk Wall 围观本体，不要再给 GET 加中间件）；9 条写端点（建频道/发消息/删频道/archive/restore/PATCH/members/convert-to-task×2）= `requireAuth()+requireNotGuest()`。注意 `POST /:id/messages` 经 @mention 派单/恢复挂起 WU 可直接触发 agent 执行与 LLM 消耗，是收紧前最危险的匿名入口。requirements-docs PUT 同为 requireNotGuest

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: P0 修复 6 traceId 入口 — 消息 POST 复用 audit 中间件落在 req 的 requestId（没有则 randomUUID）传入 routeMessage；@mention 建 WU 写 metadata.traceId（线程回复不动）；频道写操作纳入 audit 关键操作（audit.jsonl requestId 不再为空）
- ✅ 2026-07-27: @mention 正则放宽到 Unicode — `detectMention` 与 scope 剥离正则从 `[\w-]` 改为 `[\p{L}\p{N}_-]+/u`（`\w` 不匹配中文，中文名 agent 被 @ 永远落纯存储不派单）；补 CJK 用例
- ✅ 2026-07-24: API 鉴权收紧 — channels 12 条路由曾零鉴权且在 PUBLIC_API 前缀下匿名可达（P0：匿名发消息可触发 agent 执行/LLM 消耗）；GET 保持公开，写端点收 requireAuth+requireNotGuest；requirements-doc PUT 同步收紧
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
- ✅ `389c9e87`: add await to all sdd-utils consumers after Phase 4 async migration
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
