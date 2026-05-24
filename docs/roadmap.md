# Studio Roadmap

> 2026-05-24 更新：Batch 5 管线闭环 + Batch 6 知识缺口审计 + Batch 7 知识进化引擎 + RKB Phase 1 + R3 模型tier生效 + Q3a 依赖分析 + 信息保真度优化方案
> 设计文档：`memory/issue_knowledge_gap_audit.md` — 334 条目 0 架构知识，16 断点+5 Phase 实施
> RKB 分析：`memory/project_knowledge_engine_ops_gap.md` — 六层知识模型 L3~L6 缺口 + Phase 1 实现

---

## 一、设计完成状态

43 个设计断点已全部决议（26 实施 + 15 已决议 + 2 远期）。详见 `docs/ui-channel-flow-gaps.md`。

| 层级 | 已决议 | 待实施 |
|------|:--:|:--:|
| Agent (7) | ✅ | 冷启动创建 |
| Skill (8) | ✅ | — |
| Tool (39) | ✅ | — |
| MCP (4) | ✅ | 斜杠命令注册 |
| Channel (3) | ✅ | 冷启动创建 |
| 数据模型 | ✅ | ChannelMessage/RequirementsDoc/KnowledgeEntry |
| 交互模型 | ✅ | /plan、Card 替换、Discord 远程控制 |
| 中间循环 | ✅ | KK @human 确认、风险标注、errorClass |

---

## 二、实施批次

### Batch 0：基础设施（P0，阻塞所有后续批次）

**目标**：摘除 PG/Redis/pm2/WebSocket，SQLite + EventEmitter + SSE + 单进程跑起来。

| ID | 任务 | 说明 | 预估 |
|----|------|------|:--:|
| **B0-001** | Prisma SQLite 适配 | provider→sqlite, 11 String[]→JSON, 移除 pgvector | 1.5d |
| **B0-002** | Redis → EventEmitter | 35 文件, 13 channel, task-queue 重写 | 2w | ⚠️ 部分完成 |
| **B0-003** | WebSocket → SSE | ✅ 前端 useChannelMessages 已改用 SSE 实时推送 + 10s 轮询兜底 | ✅ |
| **B0-004** | pm2 → 单进程 | 删 ecosystem.config.cjs, index.ts 整合启动 | 1d |
| **B0-005** | 新 Prisma 模型 | Channel / ChannelMessage / RequirementsDoc / KnowledgeEntry | 1d |
| **B0-006** | studio up CLI 入口 | ✅ `studio up` 命令已实现：db push + daemon 启动 + server 启动 | ✅ |
| **B0-007** | studio CLI (project add / workon) + daemon IPC | ✅ daemon 常驻 Analyst+Reviewer，async spawn 并发 | ✅ |
| **B0-007a** | daemon Executor 实战测试 | 2026-05-08~09 完成：execSync→async spawn, 8 问题修复, 11 tests | ✅ |
| **B0-008** | Lurk Wall 实现 | Landing Page + read-gate 中间件 + AuthModal 认证对话框 | 1.5d |
| **B0-009** | Redis 残留清理 | ✅ 删 `redis.ts`/`redis-compat.ts`/`ioredis`，20 个模块改为 EventStore | 完成 |
| **B0-010** | PG 残留清理 | ✅ `studio-backup` 容错，`.env` 统一，server 成功启动 | 完成 |
| **B0-011** | Meeting 包 Redis 清理 | ✅ 7 文件 12 处 Redis→MemoryStore，新增 memory-store.ts | 后续 |
| **B0-009** | modelTier → 模型名映射 | tier(fast/standard/premium) → env 配置模型名 + 代码 fallback | 0.5d |

**产出**：`studio up` 后本地跑起来，Channel 列表可访问，Agent 可 @。Lurk Wall 保护全部 API。

---

### Batch 1：核心管线（P0，Agent 能干活）

**目标**：/plan → RequirementsDoc → Goal → Executor → Reviewer → Deploy 全链路。

| ID | 任务 | 状态 | 说明 |
|----|------|:--:|------|
| **B1-001** | Analyst /plan 流程 | ✅ | @Analyst ≥30字自动触发，Claude Code agent 探索代码库→RequirementsDoc |
| **B1-002** | RequirementsDoc → Goal | ✅ | 卡片[开始执行]，GoalService.createGoalFromChannelDoc → GoalPlan(approved) → GoalScheduler 分派 |
| **B1-003** | Goal 进度卡片 | ✅ | Card 原地替换（SSE），5s 轮询 Goal 进度条 |
| **B1-004** | Reviewer 审查卡片 | ✅ P0 | 多立场审查→`handleGoalSucceeded`，放行/打回/escalate |
| **B1-005** | Deploy 就绪检查 | ✅ | deployAgent.deploy() 已接入 finalizeGoalSucceeded（非阻塞） |
| **B1-006** | AcGroup 边界约束 | ✅ | Analyst prompt：一个 AcGroup 一个架构边界 |
| **B1-007** | Triage errorClass | ✅ | 八类标签 + 三级严重度 + 策略路由；TriageAgent 完整管线 |
| **B1-008** | KK 提取入库前 @human 确认 | ✅ | KK 提取→推 #系统 Channel 确认卡片→人点击确认/拒绝→入库/丢弃 |
| **B1-009** | Goal 风险标注 | ✅ | auth/schema/api/financial 四类自动标注 |
| **B1-010** | KK 撤回 Skill | ✅ | @KK retract→under_review→#系统卡片→确认(deprecated)/拒绝(published) |
| **B1-011** | Channel 归档/恢复 | ✅ | archive/restore 端点 |

**新增**:
| ID | 任务 | 状态 | 说明 |
|----|------|:--:|------|
| **B1-012** | ChannelMessage Service | ✅ | 集中化消息创建+事件发布，重构 9 处调用点 |
| **B1-013** | 模型层统一 | ✅ | fast/standard/premium 全链路，getModelForTier() 一处解析 |
| **B1-014** | ModelGateway Anthropic | ✅ | /anthropic/messages 端点，DeepSeek 官方推荐协议 |
| **B1-015** | Analyst → Agent 升级 | ✅ | 从 llmClient API 调用升级为 Claude Code agent，持久 worktree；daemon 常驻 Analyst+Executor |

**产出**：完整开发闭环——提需求→执行→审查→部署。Batch 1 全部完成。

---

### Batch 2：Channel 体验（P1，UI 可用）

**目标**：Channel 聊天、消息历史、通知、Wiki 完整可用。

| ID | 任务 | 说明 | 预估 |
|----|------|------|:--:|
| **B2-001** | Channel 列表 + 聊天 | ✅ 频道列表首页 + SSE 实时推送 + RequirementsDoc/Knowledge 卡片 | ✅ |
| **B2-002** | 消息历史 | ✅ 分页加载(loadMore) + 今天/昨天/日期分隔线 | ✅ |
| **B2-003** | 通知中心 | ✅ 铃铛图标 + 未读计数 badge + 下拉列表 + 点击跳转 | ✅ |
| **B2-004** | @human 通知路由 | ✅ 标题闪烁(1s交替10s) + 通知中心 + SSE 实时 | ✅ |
| **B2-005** | Triage 全局横幅 | ✅ 页面顶部常驻，critical=红色/other=橙色，可关闭 | ✅ |
| **B2-00x** | @mention 自动补全 | ✅ 输入@弹出 Agent 列表，↑↓选择 Enter 确认 Esc 取消 | ✅ |
| **B2-006** | 已完成卡片折叠 | ✅ 默认只显示2条 + 展开按钮 | ✅ |
| **B2-007** | 新建 Channel 表单 | ✅ POST /channels + 前端表单(name+type) | ✅ |
| **B2-008** | LLM Wiki | ✅ 全文搜索(防抖300ms) + [[双向链接]] + 图谱可视化(@xyflow/react) + 编辑面板 | ✅ |
| **B2-009** | RequirementsDoc 编辑面板 | ✅ 编辑按钮→textarea→保存(重置draft)/取消 | ✅ |
| **B2-010** | 首次默认视图 | ✅ 首页 auto-navigate 到 #研发 | ✅ |
| **B2-011** | 未读消息小红点 | ✅ SSE 跟踪 per-channel 计数, 点击清零 | ✅ |
| **B2-012** | Channel 删除 Goal fallback | ✅ DELETE /channels/:id + Goal→#研发 | ✅ |

**产出**：完整的浏览器端 Channel 操作台。

---

### Batch 3：Discord 集成（P1，移动端控制）

**目标**：Discord 作为完整远程入口——看进度、发指令、控制 Claude Code。

| ID | 任务 | 说明 | 预估 |
|----|------|------|:--:|
| **B3-001** | Discord 斜杠命令注册 | ✅ APPLICATION_COMMAND 处理器 + 注册脚本 | ✅ |
| **B3-002** | Discord 远程控制 | ✅ /studio run/progress/stop + AgentExecutor child 追踪 + stop SIGTERM | ✅ |
| **B3-003** | studio run CLI | ✅ `studio run "需求" [--wait]` → #研发 → @Analyst → Goal 管线 | ✅ |
| **B3-004** | Discord 消息推送（单向） | ✅ sendChannelMessage() 单向推送 @human + Agent 卡片到 Discord | ✅ |
| **B3-005** | Auditor "应用建议" 分权限执行 | ✅ 4 规则检测(weight/status/tuning/prompt) + 低风险自动执行(prisma.skill.update) + 高风险弹确认卡片(auditor_suggestion cardType) + channel 动作(auditor_apply_confirm/reject) + AuditorSuggestionCard 前端 | ✅ |

**产出**：手机上 Discord 控制电脑上的 Claude Code，看进度、发指令。CLI 和 Discord 双入口触发需求执行。

---

### Batch 4：远期（等数据积累）

| ID | 任务 | 说明 | 触发条件 |
|----|------|------|------|
| **B4-001** | 系统级 GC | Auditor 发现 stale Skill/重复知识/废弃文档→推 #系统→人决定 | Auditor 运行 ≥1 月 |
| **B4-002** | GoalTemplate | KK 提取同类型 Goal 模式，供 Analyst /plan 加载 | KK 积累 ≥20 Goal |
| **B4-003** | Agent→Tool 自动化提取 | Auditor 发现 Skill 稳定→人确认→Executor 实现 Tool 代码 | Skill 积累 ≥10，运行 ≥3 月 |

---

## Batch 5：管线闭环修复 (2026-05-22)

### 背景

SessionManager 和 AgentExecutor 各自内联了 ~150 行相同的 Claude CLI 进程 IO 代码（execAsync spawn、session-id 持久化、JSON envelope 解析）。ReviewAgent 第三份拷贝。DeployAgent 只生成部署文本，不做实际 merge/push/deploy/清理。导致 32 个 task 分支泄漏。

### 完成项

| ID | 任务 | 说明 |
|----|------|------|
| **B5-001** | 进程 IO 去重 | execSh / resolveSessionId / readSessionIdFile / readProgress / writeProgress / readPhaseBridge → `@dommaker/studio-shared/node` (process-io.ts)，SessionManager/AgentExecutor/ReviewAgent 三处内联代码删除 |
| **B5-002** | DeployAgent 重写 | merge to master → git push origin → VPS deploy (docker build/push/compose up/health) 或 Company checklist → cleanup task/* branches + worktrees |
| **B5-003** | Monitor GC | git worktree prune + 24h+ 残留 worktree 目录清理，5min 周期 |
| **B5-004** | 分支清理 | 32 个已合并 task/worktree/daemon 分支全部删除 |
| **B5-005** | claude-session 废弃 | npm deprecate + GitHub 归档。代码本质是通用 IO，错放成了独立包 |
| **B5-006** | 管线文档 | `memory/project_pipeline_flow.md` — 9 阶段管线 + 8 Agent 职责表 + 状态机 + 模型层 |

### 管线闭环（修复后）

```
Executor 完成
  → Integration: merge + tsc + test
  → Review Gate: 多立场审查
  → DeployAgent:
      1. merge integration → master
      2. git push origin master
      3. deploy (VPS: docker | Company: checklist)
      4. cleanup task/* + worktrees
  → Monitor GC: 5min 兜底清理
```

### 架构决策记录

- **不新创建 npm 包**：6 个通用 IO 函数移入已有的 `studio-shared/node`，不建 `shell-kit`
- **DeployAgent 不创建 PR**：代码已过 Integration+Review 双重门，手动 PR 审批多余
- **Agent ≠ 产物生命周期管理者**：Agent 只负责执行，最后一个消费者 (DeployAgent) 负责清理

---

## Batch 6：知识缺口审计 — 源头捕获 + 冷启动 + 新鲜度自治 (2026-05-22)

> 设计文档：`memory/issue_knowledge_gap_audit.md`
> 核心矛盾：harness 知识引擎完整（Store/Query/Lifecycle/Linter/Doctor/Evolver/Importer），但输入源只有 Monitor+Triage 故障模式。334 条目 0 架构知识。Agent 执行结果、CST 会话对话（78MB×7天）全部丢弃。

### 三层边界（不可混淆）

```
CST (Human Shell)  →  Studio (Pipeline Agents)  →  Harness (Knowledge Engine)
文件事件松耦合           API 调用                       存储/查询/生命周期
```

交互规则：CST→Studio 走文件事件(cst-emit.sh→events-daemon)，Studio→Harness 走 API，CST 不直接调 Harness。不新建 npm 包。不新建 Agent。

### P0：源头捕获 — 止住正在流失的知识

**对应断点**：A (CST 会话全丢)、B (Agent 执行结果全丢)、C (去重失效 328 条重复)

#### P0a：Agent 执行完成时全量提取

| ID | 任务 | 说明 |
|----|------|------|
| **B6-001** | extractFromReview | agent-event-listener → KnowledgeAgent 新增方法：ReviewResult(issues/suggestions/stanceReports/acResults) → LLM 提取 → ingestEntry |
| **B6-002** | extractFromError | agent-event-listener → KnowledgeAgent 新增方法：error+errorChain → pitfall 条目 |
| **B6-003** | extractFromCompletion | agent-event-listener → KnowledgeAgent 新增方法：completionOutput(changedFiles/completedAcs/siblingAdvice) → LLM 提取 |
| **B6-004** | extractFromDeploy | agent-event-listener → KnowledgeAgent 新增方法：DeployAgent 部署发现(merge/push/deploy/cleanup) → LLM 提取 |

关键设计：触发点 agent-event-listener.ts 不改架构只加调用行；所有 extract fire-and-forget 不阻塞管线。

#### P0b：CST 会话归档时自动提取

| ID | 任务 | 说明 |
|----|------|------|
| **B6-005** | cstnew → cst-emit.sh session:archive | `/root/.zshrc` cstnew 函数加一行 emit，备份后异步触发 |
| **B6-006** | events-daemon session:archive 路由 | 新增路由规则：session:* → POST Studio API（不经过 Discord webhook） |
| **B6-007** | POST /api/knowledge/extract-session | 新端点：接收 sessionFilePath → 202 Accepted → 异步处理 |
| **B6-008** | KnowledgeAgent.extractFromSession() | 流式读 JSONL → 过滤 user+assistant → 截断 50K chars → LLM 提取 → ingestEntry × N → Discord 通知 |

架构决策：不调 `claude -p --resume`（已验证不可行）；直接读 JSONL 文件；不阻塞 cstnew（emit 后立即启动新会话）；只覆盖 CST（`_CS_ID` 固定），裸 claude 暂不覆盖。

#### P0c：修复去重写入

| ID | 任务 | 说明 |
|----|------|------|
| **B6-009** | 排查 ingestEntry 去重失效 | 确认 TriageAgent 是否绕过 ingestEntry 直写 store.save()；title 是否有时间戳后缀致去重失效 |
| **B6-010** | 修复 + dedup log | 如直写改调 ingestEntry；如 title 变化加 normalizedTitle；每次去重命中 logger.info |

### P1：知识冷启动 — 存量导入

**对应断点**：D (memory 文件腐烂)、E (四源冷启动从未执行)

#### P1a：修复腐烂 memory 文件

| ID | 任务 | 说明 |
|----|------|------|
| **B6-011** | 弃用 project_4_agent_system.md | 加 DEPRECATED 标记，指向 pipeline_flow |
| **B6-012** | 弃用 project_new_architecture_gaps.md | 加 DEPRECATED 标记，指向 issue_knowledge_gap_audit |
| **B6-013** | 标记 issue_studio_harness_context_integration.md | 加 SUPERSEDED by B5 头部 |
| **B6-014** | 创建 project_batch_progress_2026_05_22.md | 消除 MEMORY.md 悬挂引用 |

#### P1b：四源冷启动

| ID | 任务 | 说明 |
|----|------|------|
| **B6-015** | harness types.ts 加 architecture 类型 + system 层 | KnowledgeType 加 `'architecture'`，StorageLayer 加 `'system'` |
| **B6-016** | KnowledgeAgent.coldStartAll() | importFromDocs(memory+CLAUDE.md) + importFromCode(package.json+tsconfig) + importFromGit(近期提交) + importManual(管线流程) |

### P2：新鲜度自治 — 不腐烂

**对应断点**：I (新鲜度机制全手动)、F (KnowledgeBus 写入者少)、G (G-003 EnvSnapper)、H (G-004 DecisionChain)、L (ReviewAgent→KB)

#### P2a：MonitorAgent 驱动新鲜度循环

| ID | 任务 | 说明 |
|----|------|------|
| **B6-017** | KnowledgeQuery 引用追踪 | query() 返回条目时更新 lastReferenced（衰减链前提） |
| **B6-018** | KnowledgeDoctor.healthScore() | 创建 harness/src/knowledge/doctor.ts：综合评分 orphan/outdated/decay/lowRef 0-100 |
| **B6-019** | MonitorAgent.check() 扩展 | 每次 check 调 healthScore()；<60 分 Discord alert；距上次衰减>24h 则 runDecayCycle()+autoFix() |

#### P2b：接通已实现的断线

| ID | 任务 | 说明 |
|----|------|------|
| **B6-020** | G-003 EnvSnapper.start() 确认 | 验证 index.ts 已调用 startPeriodicSnapshots()（代码已实现，需确认） |
| **B6-021** | G-004 DecisionChain extractFromExecution | 验证 KnowledgeAgent.extract() 已调用（代码已实现，需确认） |
| **B6-022** | KnowledgeBus 多写入者 | Auditor/PostEval/Deploy → recordPattern()（各 Agent service） |
| **B6-023** | ReviewAgent → KnowledgeBus | review-agent.service.ts → recordPattern({ source: 'reviewer' }) |

### P3：智能进化（Phase 6+，不在当前范围）

| 能力 | 说明 |
|------|------|
| 跨条目合成 | 多条相关条目 → LLM 合成 → 新条目 |
| duplicate 自动归档 | autoFix 扩展覆盖 duplicate lint 类型 |
| 源文件变更检测 | memory/package.json 变更 → 自动重新导入 |
| 语义矛盾检测 | 内容级语义对比，非仅成熟度差检测 |

### 完成效果

```
P0 完成后: 每次 cstnew + Agent 执行 → 知识自动入库，去重正常
P1 完成后: 存量 memory+code+git 四源导入，问"管线怎么跑"直接答
P2 完成后: 衰减/去重/修复全自动，健康评分<60 告警，知识库自治运行
P2.5 (2026-05-22): 质量闸 + 引用验证 + 证据驱动晋升
P3 (远期): 跨条目合成，完全自治
```

---

## Batch 6.5：知识进化闭环 — 质量闸 + 引用追踪 + 成熟度晋升 (2026-05-22)

> 第一性分析：P0-P2 修好了"知识怎么入库"，但不知道"知识有没有用"。
> `tryPromote()` 函数已实现有测试，但从未被调用。所有知识永远 draft，只会向下 decay。

### 五环进化模型

```
CAPTURE → QUALITY → INJECT → VERIFY → REFINE
   ✅        ❌        ⚠️        ❌         ❌
```

| 环 | 卡点 | 修复 |
|----|------|------|
| QUALITY | LLM 提取直通入库，无质量闸 | `KnowledgeLinter.validateEntry()` 入库前校验 |
| INJECT | 知识注入不带 ID，无法追踪 | prompt 中每条知识带 `[KNOWLEDGE #REF-001]` 标识 |
| VERIFY | Agent 用了哪条知识？不知道 | completion 时解析输出中的引用 → `recordReference()` |
| REFINE | `tryPromote()` 从未被调用 | MonitorAgent health check 时顺带运行 |

### 实施清单

| # | 改动 | 文件 |
|---|------|------|
| 1 | `KnowledgeLinter.validateEntry()` 质量闸 | `harness/src/knowledge/lint.ts` |
| 2 | `KnowledgeAgent.validateBeforeIngest()` 包装器 | `knowledge-agent.service.ts` |
| 3 | `KnowledgeQuery.formatCompactForPrompt` 输出带 ID | `knowledge-query.service.ts` |
| 4 | `agent-event-listener.ts` 解析引用 + recordReference | `agent-event-listener.ts` |
| 5 | `MonitorAgent.checkKnowledgeHealth()` 加 tryPromote | `monitor-agent.service.ts` |

### P2.5b 紧急修复 (2026-05-22)

> 第一性审计发现 P2.5 有两个致命 bug：
> 1. `recordKnowledgeRefs()` 扫描的是 `completionOutput`（结构化元数据），不是 Agent 输出文本 → [REF:xxx] 永远扫不到
> 2. `tryPromote()` 的 `projects.length >= 2` 在单项目部署永远不满足
> 3. ReviewAgent/MonitorAgent 不发知识库 → 没有消费者闭环

| # | 改动 | 文件 |
|---|------|------|
| 1 | 从 worktree `.progress.json` notes + agent 输出文件扫描 [REF:xxx] | `agent-event-listener.ts` |
| 2 | 新增单项目晋升路径：referenced > 3 次 + 来自 2+ source → proven | `harness/src/knowledge/lifecycle.ts` |
| 3 | ReviewAgent `buildReviewPrompt` 注入知识总线上下文 | `review-agent.service.ts` |
| 4 | MonitorAgent `checkKnowledgeHealth` 参考历史知识调整阈值 | `monitor-agent.service.ts` |
| 5 | DeployAgent deploy() 注入知识总线上下文 | `deploy-agent.service.ts` |
| 6 | AuditorAgent dailyAudit() 注入知识总线上下文 | `auditor-agent.service.ts` |

### 当前消费者覆盖

```
Analyst       ✅ formatAllForPrompt (5 类全量 + 总线)
Executor      ✅ formatCompactForPrompt + getRecentContext
ReviewAgent   ✅ getRecentContext (P2.5b)
DeployAgent   ✅ getRecentContext (P2.5b)
AuditorAgent  ✅ getRecentContext (P2.5b)
PostEval      ⚠️ (evaluate 是 LLM 调用, context 注入不适合)
MonitorAgent  ⚠️ (阈值调整需要结构化的知识查询, 非 prompt 注入)
```

---
## 管线监控架构 (2026-05-08 分析)

### 四个根本问题

| 问题 | 当前状态 | 关键缺口 |
|------|:--:|------|
| 做对了吗？(Quality Gate) | ❌ | B1-004 Reviewer 未接入，Executor 完成直接标记 succeeded |
| 花了多少？(Cost Tracking) | ⚠️ | B1-016 PipelineRun 已实现 token/duration/cache |
| 从哪坏的？(Traceability) | ❌ | 无端到端 traceId，失败后靠翻 .agent.log |
| 在变好吗？(Feedback Loop) | ❌ | assessTaskComplexity 无校准，tier 选择从不验证 |

### 四层 Agent 监控职责

```
Monitor Agent (实时 + 趋势)
  ├── costTrend: 最近 1h token 消耗异常?
  ├── qualityTrend: flash 失败率上升?
  ├── cacheEfficiency: 缓存命中率下降?
  └── sessionHealth: daemon session 上下文膨胀?

Reviewer Agent (单次质量门, B1-004)
  ├── AC 完成度验证
  ├── test/lint/type 结果
  ├── diff 合理性
  └── tier 适用性: flash 产出质量达标? 不达标 → 建议升级

Auditor Agent (跨任务审计, B4-001)
  ├── 周报: 模型/任务类型成功率矩阵
  ├── 建议: "schema 变更类升级为 pro"
  └── 推 #系统 → 人决定 → KK 提取

KK (规则化, B1-008/B1-010)
  ├── Pitfall: "flash 在 schema 变更时成功率 72%"
  ├── Pattern: "12 文件替换任务用 standard 即可"
  └── Analyst 加载 → RequirementsDoc 中标注 tier 建议
```

### 待采集指标

| 阶段 | 已有 | 缺失 |
|------|:--:|------|
| @Analyst 触发 | skip 去重 ✅ | skip 次数、AC 可执行性 |
| Analyst 分析 | token/duration/cache ✅ | 文件路径命中率 |
| GoalPlan 创建 | tier 选择 ✅ | 选 tier 的理由 |
| GoalScheduler | - | 排队时长、并行度 |
| Executor 执行 | token/duration ✅ | retry 次数、stuck 次数、diff 行数 |
| 集成 step-999 | - | merge 冲突、npm test 结果 |
| 端到端 | Goal.id ✅ | 统一 traceId 串联全流程 |

### 结构缺口优先级

| 优先 | ID | 说明 |
|:--:|------|------|
| P0 | B1-004 | Reviewer 接入——没有质量门管线不可信（下一步） |
| P0 | B0-007 | ✅ daemon Executor 完成——async spawn + 并发 + cache 复用 |
| P1 | B1-005 | Deploy 接入——安全门 |
| P1 | Triage 路由 | TriageAgent 接到 GoalExecution.failed 事件 |
| P2 | B1-008/B1-010 | ✅ KK @human 确认 + 撤回——知识闭环已完成 |
| P2 | B4-001 | Auditor 周期审计——系统级优化 |
| P3 | tier 校准 | assessTaskComplexity 根据历史成功率调整 |

---

| Batch | 内容 | 预估 |
|:-----:|------|:--:|
| B0 | 基础设施 | ~3w |
| B1 | 核心管线 | ~2w |
| B2 | Channel UI | ~1.5w |
| B3 | Discord | ~1w |
| B4 | 远期 | 等数据 |
| **总计** | | **~7.5w** |

---

---

## 全流程卡点分析 (2026-05-09 更新：P0 全部清零)

### P0 — 管线跑不通 (5 → 0)

| # | 卡点 | 类型 | 说明 |
|---|------|------|------|
| 1 | Reviewer 未接入 | ✅ 已修复 | `handleGoalSucceeded` 接入 `reviewAgent.review()`，放行/打回/escalate |
| 2 | PR 创建静默跳过 | ✅ 已修复 | `createGoalFromChannelDoc` 补 `projectId` 参数 |
| 3 | agent-executor 前置检查 | ✅ 已修复 | Docker+tmux+Redis → async spawn `claude --print`。Session loop 保留 |
| 4 | CLI studio up | ✅ 已实现 | `studio up`：Prisma db push + 3 daemon sessions + server 启动 |
| 5 | Deploy 未接入 | ✅ 已修复 | `deployAgent.deploy()` 接入 `finalizeGoalSucceeded`（PR 创建后非阻塞执行） |

### P1 — 流程断链 (6 → 0 清零)

| # | 卡点 | 状态 |
|---|------|:--:|
| 6 | Auditor Agent 完全缺失 | ✅ `auditor-agent.service.ts` 每日审计 + 失败归类 + #系统推送 |
| 7 | KK @human 确认缺失 (B1-008) | ✅ knowledge_confirm 卡片 → #系统 → 人确认/拒绝 |
| 8 | KK 撤回 Skill (B1-010) | ✅ @KK retract→under_review→卡片确认 |
| 9 | RoleConfig 只覆盖 5/7 角色 | ✅ RoleType 扩展至 7 个 (+triage +deploy) |
| 10 | Triage 未接到 GoalExecution.failed | ✅ `handleGoalFailed` → `triageAgent.handleAlert()` |
| 11 | errorClass 设计-代码不一致 | ✅ TriageErrorClass 重命名为设计八类 |

### P2 — 基础设施 (5)

| # | 卡点 | 类型 |
|---|------|------|
| 12 | daemon 只注册 Analyst | ✅ 移除孤儿 executor session，仅保留 analyst+reviewer；Executor 走 AgentExecutor per-execution worktree（隔离硬需求）|
| 13 | 无端到端 traceId | ✅ agent-executor(7) + agent-event-listener(3) + goal-scheduler(1) + review-agent(1) 已补 executionId/goalId |
| 14 | Meeting 包 Redis 残留 (B0-011) | ✅ agent-completer + health-monitor → MemoryStore/eventBus, redis-context-sharer → context-sharer |
| 15 | WebSocket server 文件残留 | ✅ websocket/server.ts 已移除 |
| 16 | Discord 出站+斜杠命令全缺 | ✅ B3-001~004 完成：斜杠命令 + run/progress/stop + CLI run + 单向推送 |

### P3 — 前端/UI (6)

| # | 卡点 |
|---|------|
| 17 | 频道列表不是默认首页 |
| 18 | 通知中心不存在 |
| 19 | @mention Agent 自动补全不存在 |
| 20 | 消息轮询 3s 非 SSE 推送 |
| 21 | RequirementsDoc 编辑面板不存在 |
| 22 | LLM Wiki 整体未实现 | ✅ B2-008 完成：Wiki API + 前端列表/详情/图谱 + 编辑面板 |

### P4 — 远期 (5)

| # | 卡点 |
|---|------|
| 23 | Auditor 反馈闭环 (B4-001) |
| 24 | model tier 校准从未验证 |
| 25 | GoalTemplate (B4-002) |
| 26 | Discord 远程控制 (B3-002) | ✅ /studio run/progress/stop + AgentExecutor child 追踪 + stop SIGTERM |
| 27 | checkAllStepsCompleted id.includes('integrate') 逻辑错误 | ✅ 已修复 (N2) |

### 最优先修复（2026-05-09 最终更新 — P0 全部清零）

1. ~~P0-1: Reviewer 接入~~ ✅
2. ~~P0-2: createGoalFromChannelDoc 补 projectId~~ ✅
3. ~~P0-3: agent-executor async spawn~~ ✅
4. ~~P0-4: CLI studio up~~ ✅
5. ~~P0-5: Deploy 接入~~ ✅
6. ~~N2: integrate 字符串匹配~~ ✅
7. ~~N3: processGoal 并发保护~~ ✅
8. ~~N4: progressSnapshots 内存泄漏~~ ✅
9. ~~N5: 统一 completion check~~ ✅
10. ~~N7: localhost 硬编码~~ ✅
11. ~~H1: afterReview 启用~~ ✅
12. ~~H2: checkBeforeTaskComplete 接入~~ ✅

### 下一步（按优先级）

**P1 管线增强**:
1. P1-10: Triage 接到 GoalExecution.failed → TriageAgent 处理
2. P1-9: RoleConfig 补充 Triage/Deploy 角色（解除 N10 阻塞）
3. P1-6: Auditor Agent 实现

**债务清偿**: ✅ 全部完成

**远期**:
8. N10: GateChecker 全量接入（需先做 Meeting 解耦）
9. N11: AgentRouter harness 约束集成（或随旧路径一起移除）

---

## 八、深度审计新发现 (2026-05-09 更新：N1-N7 + H1-H2 已修复)

harness 约束集成审计 + 全代码扫描发现的 12 个新断点。7 个已修，5 个待处理。

### N-严重 (3→0)

| # | 问题 | 状态 | 修复 |
|---|------|:--:|------|
| N1 | deployAgent 零引用 | ✅ | 接入 `finalizeGoalSucceeded`（P0-5） |
| N2 | `id.includes('integrate')` 字符串匹配 | ✅ | → `stepIndex === 999` 字段判断 |
| N3 | Goal 管线 processGoal 零锁 | ✅ | `processingGoals` Set 防并发重复分派 |

### N-高 (4→1 剩余)

| # | 问题 | 状态 | 修复 |
|---|------|:--:|------|
| N4 | `progressSnapshots` 内存泄漏 | ✅ | 查完后清理非 running 条目 |
| N5 | AgentEventListener ↔ GoalScheduler 重复 completion check | ✅ | 标记 AgentEventListener 路径为死代码 |
| N6 | WebSocket server 完全活跃（B0-003 残留） | ✅ | 已删除 websocket/server.ts + types 类型 + monitoring gauge + executions 死代码 |
| N7 | Monitor/Triage `localhost:3001` 硬编码 | ✅ | → `process.env.PORT \|\| 3001` |

### N-中 (5→0 清零)

| # | 问题 | 状态 |
|---|------|:--:|
| N8 | 9+ 处静默空 catch | ✅ 全量审计 60+ 处，均为正确 pattern（cleanup/fallback/best-effort），无需修改 |
| N9 | `WORKTREES_DIR` 不一致 | ✅ monitor-agent 补 env fallback；agent-completer 硬编码 /root/worktrees→os.homedir() |
| N10 | `GateChecker` 8 gate 零调用 | ⚠️ `checkBeforeTaskComplete` light gate 已接入；全量推迟到 P1（需 Meeting 解耦） |
| N11 | `AgentRouter` 旧路径零 harness 约束 | ✅ 已加 beforeAgentDispatch + buildAgentConstraintPrompt |
| N12 | `.harness/custom-constraints.yml` 无项目专属约束 | ✅ 4 条约束已定义，harness commit 时加载验证 |

### Harness 约束系统评估（更新）

| 项目 | 旧状态 | 新状态 |
|------|:--:|:--:|
| hook 定义 | 6 ACTIVE, 3 DISABLED, 1 零调用 | **8 ACTIVE**, 1 DISABLED (`afterPrCreated`), 1 部分接入 (`GateChecker`) |
| 运行时阻塞 | 1 blocking | **2 blocking** (+`checkBeforeTaskComplete`) |
| `afterReview` | disabled | ✅ enabled → TraceCollector + FailureRecorder |
| `checkBeforeTaskComplete` | disabled + 零调用 | ✅ enabled + blocking + `finalizeGoalSucceeded` 接入 |
| `afterPrCreated` | disabled | ⬜ 仍 disabled（空函数体，PR 创建走 GitHub API 无需 hook） |
| CI 检查 | 生效 | 生效（无变化） |
| 项目专属约束 | 零 | ⬜ 待定义

---

## 四、依赖关系

```
B0（基础设施）
  └── B1（核心管线）
        ├── B2（Channel UI）
        └── B3（Discord 集成）
              └── B4（远期，等数据）
```

B2 和 B3 可并行。

---

## 九、第一性原理分析 (2026-05-09，2026-05-13 更新：Agent 分类纠正 + 三层闭环 + 反馈回路)

管线已从"跑不通"到"全链路连通"。以下从第一性原理出发，分析结构性问题——不是"什么坏了"而是"什么设计不对"。

### 1. Daemon Executor 与 AgentExecutor 双轨

**现状**: daemon 注册了 executor session（`~/worktrees/executor-main`），但 GoalScheduler 不使用它——而是调用 `agentExecutor.execute()`，后者创建 per-execution worktree。

```
daemon.submitJob('executor', ...) ← 零调用
agentExecutor.execute(task)       ← GoalScheduler 实际路径
```

**影响**: executor daemon session 是孤儿。prompt cache 复用收益只在 Analyst 身上（daemon session），Executor 每条 execution 冷启动。

**根因**: AgentExecutor 的 per-execution worktree 模型与 SessionManager 的单 worktree 模型不兼容。要合并需要让 SessionManager 支持动态 worktree 或 per-task worktree override。

### 2. 无端到端 traceId

**现状**: Goal.id 存在于所有阶段，但没有人把它写入各阶段的日志/metrics/trace。

```
@Analyst → RequirementsDoc → Goal.id
  → GoalExecution.<id> → AgentExecutor 日志用 executionId
  → Reviewer 日志用 taskId (但这是 goalId)
  → Deploy 用 executionId
```

没有一个统一 key 串联全流程。失败回溯要翻 4 个不同地方的日志。

**修复方向**: Goal.id 作为 traceId 注入所有 spawn 命令的环境变量，各 Agent 写结构化日志时带上。

### 3. Model Tier 选择无反馈校准

**现状**: `assessTaskComplexity()` 用关键词匹配选 tier。Auditor 每天统计成功率但不反馈给 Analyst。

```
flash 被选中 → 执行 → 失败了 → Triage 处理 → Auditor 统计
                                           ↑
                                    没有反馈回路
```

**修复方向**: Auditor 积累 ≥20 条数据后，产出 tier 成功率矩阵，KK 提取为 Pitfall（"flash 在 schema 变更时成功率 72%"），Analyst 加载后自动规避。

### 4. Integration Step 在单 AC 组时多余

**现状**: 即使只有一个 AC 组（无并行），也创建 integration step。这时 integration step 做的"merge branches + tsc + test"等于空操作（只有一个分支）。

**影响**: 浪费一个 GoalExecution + 一次 Claude Code spawn（10-30 min）。

**修复方向**: `checkAllStepsCompleted` 中加判断：如果只有 1 个 step 且 succeeded → 跳过 integration step，直接触发 handleGoalSucceeded。

### 5. KK @human 确认缺失 — 知识闭环断裂

**现状**: KnowledgeAgent 异步提取知识直接写入 Document 表（draft maturity），不经任何人审批。

**设计意图**: KK 提取 → 推 #系统 → 人确认 → 入库。B1-008 已实现：knowledge_confirm 卡片 → channelMessageService → 人点击确认/拒绝。

**影响**: 低质量/错误知识静默入库，decay check 30 天后自动 archive——可能丢失有价值知识。

**修复方向**: KnowledgeAgent 提取后不直接写入，改为 channelMessageService.createAgentMessage('#系统', 'KK', card)，人点击确认/拒绝后再写库。

### 6. 结构性债务（不影响管线但会累积）

| 债务 | 说明 |
|------|------|
| errorClass 名不一致 (P1-11) | ✅ TriageErrorClass 已重命名为设计八类 |
| daemon executor 孤儿 | ✅ 已移除，仅保留 analyst+reviewer；Executor 走 AgentExecutor per-execution worktree |
| WebSocket 代码文件未删 | `websocket/server.ts` 216 行还在，只是不初始化 |
| AgentRouter 零 harness 约束 | 旧执行路径完全绕过约束系统 |
| GateChecker Meeting 耦合 | 8 gate 全实现但依赖 ContextSharer(Meeting)，Goal 路径无法用 |

### 7. Agent 分类：三层不是二类 (2026-05-13)

从第一性原理——Agent 必须**可寻址（被 @）、可沟通（@human）、常驻（有状态有机器的 daemon）**——分为三层：

```
Tier 1 — Always-LLM Agent (全 LLM):
  Analyst, Reviewer, KK
  核心函数 = LLM 推理。必须 daemon 常驻 + Claude Code 运行时。

Tier 2 — Hybrid Agent (纯代码核心 + LLM 边界):
  Auditor: 95% 统计聚合(纯代码) → 日报告 + 5% 模式解读/推荐(@LLM)
  Triage:  80% 已知修复管道(纯代码) → 诊断/修复 + 20% 未知故障(@LLM) + @human沟通
  Deploy:  80% 检查清单(纯代码) + 20% 新项目部署计划(@LLM)

Tier 3 — Pure Infrastructure (纯代码):
  Monitor, AgentExecutor, GoalScheduler, EvolutionScheduler
  不被 @、不参与 Channel 对话、不需要 RoleConfig。
  Monitor 活在 sidebar → 通过 Triage 间接跟人对话。
  AgentExecutor 是 spawn session loop，智能在它 spawn 的 Claude Code，不在它自身。
```

**关键纠正**：Auditor/Triage/Deploy 当前实现是纯代码，但**设计意图是 Hybrid**。
- 当前 Auditor 只统计不解读 — 正确的 Auditor 应该能回答 "@Auditor 为什么失败率上升？"
- 当前 Triage 只跑已知命令 — 正确的 Triage 应该能诊断未知故障、向 @human 解释
- 当前实现是 placeholder，不是最终态

**Monitor 为什么是纯代码？** 设计明确说 "不在 Channel 里说话，活在右侧状态栏"。它不需要 LLM。你不需要 @Monitor——它通过 Triage 跟你对话。

### 8. Phase 管线模型 vs 三层闭环 (2026-05-13)

原 Phase 1→7 线性模型把不同 cadence 的组件强行塞进执行阶段：

```
Phase 模型说的:                    实际:
Phase 3 → Monitor                  Monitor 5min 轮询，与 Phase 无关
Phase 5 → Auditor                  Auditor 24h 周期，与 Phase 无关
Phase 7 → Evolution                Evolution 三层 (per-exec / daily / weekly)
Triage "全流程横切"                 Triage 只收 4 种系统事件，执行覆盖 1%
```

**正确模型是三层闭环**——不同 cadence 的检测-响应-学习：

```
CADENCE              DETECTION              RESPONSE              LEARNING
───────────────────────────────────────────────────────────────────────────
per-event    Executor fail/complete  → Reviewer/Deploy/KK   → KK extract
            Reviewer reject          → repair loop (max 3)  → (缺→Evolution)

5min         Monitor.check()         → logger only           → (缺→Triage)
10s          GoalScheduler           → dispatch/recovery     → —

daily        Auditor.dailyAudit()    → #系统 report only     → (缺→Triage)
24h          Evolution.decayCheck()  → auto-archive          → maturity ladder

weekly       Evolution.mesoEvolution → constraint proposals  → (缺→Analyst)

threshold    Evolution.recordFailure → (缺: 2 trigger paths) → autoEvolve
```

### 9. 反馈回路：4 条中 2 条断裂 (2026-05-13)

```
✅ 已通:
  Triage → KK (incident → knowledge)
  KK → Analyst (pitfall → plan 加载)
  Auditor → Analyst (tier 成功率 → assessTaskComplexity, saveTierStats+DecisionAudit+async load)

⚠️ 部分:
  Reviewer → Evolution (打回 ≥2 → 审查标准调整)
    Phase 3 已加 recordReviewRejected + pattern buffer，端到端验证待数据积累
```

### 下一优先级（2026-05-09 原始）

1. ~~**KK @human 确认 (B1-008)**~~ ✅ knowledge_confirm 卡片→#系统→人确认/拒绝
2. ~~**端到端 traceId**~~ ✅ STUDIO_GOAL_ID/STUDIO_EXECUTION_ID 注入 spawn env + .progress.json
3. ~~**单 AC 组跳过 integration**~~ ✅ checkAllStepsCompleted 加单 AC 组判断
4. ~~**errorClass 统一 (P1-11)**~~ ✅ TriageErrorClass 重命名为设计八类

### 新优先级 (2026-05-13 更新)

**结构修复（第一性）**:

1. **Monitor 升级路径 (Phase 1)** — critical alert 调 `triageAgent.handleAlert()`，改动最小，检测已有
2. **静默 → 可见 (Phase 2)** — ~53 处 `catch{}` / fire-and-forget 替换为 log+event
3. **反馈回路打通** — Auditor→Analyst (tier 校准)、Reviewer→Evolution (打回触发)
4. **三层闭环补齐** — Monitor→Triage 执行级 + Auditor→Triage 日扫描 + Evolution 触发扩展

**功能积累（等数据）**:
5. **Model Tier 校准 (B4-002)** — Auditor 积累 ≥20 条数据后产出 tier 成功率矩阵
6. **GateChecker 全量接入 (N10)** — 需先解耦 Meeting ContextSharer→Goal 路径可用

---

## 十、故障监控覆盖分析 (2026-05-13)

### 全量审计结果

全管线 209 个故障点审计：

```
209 故障点
  ├─ 2 条 → Triage（Goal 级 zombie + 系统资源，3 次确认后）
  ├─ 21 条 → Monitor 检测到但只 log，不升级
  └─ 186 条 → 静默（catch{} / log only / fire-and-forget）
```

76 个 catch 块，60+ 已审计为正确 pattern（cleanup/fallback/best-effort，N8），剩余 ~53 处需修。

### 四层 Agent 监控架构

从第一性原理：每类故障的**检测机制**决定它归哪个 Agent。

```
┌─────────────────────────────────────────────────────────────────┐
│ 检测机制                   归属 Agent       触发条件             │
├─────────────────────────────────────────────────────────────────┤
│ 阈值比较（轮询可检测）  →  Monitor        X > N → 升级给 Triage  │
│ 跨执行聚合（日周期）    →  Auditor        趋势/模式 → 升级 Triage │
│ 模式 → 约束调整         →  Evolution      累计失败 → autoEvolve  │
│ 实时响应 + 自动修复     →  Triage         诊断 → 动作 → 解决/升级│
└─────────────────────────────────────────────────────────────────┘
```

### Monitor Agent（已实现检测，缺升级路径）

6 项检查全部实现（`monitor-agent.service.ts`），但只在 `check()` 中 `logger.error/warn/info`，**未调 `triageAgent.handleAlert()`**。唯一升级 Triage 的是 `systemTriageCheck()`（系统资源/僵尸/DB），需 3 次确认窗口。

| # | 检查项 | 当前行为 | 应改为 |
|---|--------|----------|--------|
| M1 | `checkFailureTrend` — 1h 内 ≥3 失败或 >50% 失败率 | `logger.warn/critical` | ✅ critical → `escalateToTriage()` |
| M2 | `checkStuckGoals` — running >30min | `critical` alert | ✅ critical → `escalateToTriage()` (execution_stuck) |
| M3 | `checkProgressStagnation` — completedSteps 无变化 | Level 1 warning / Level 2 critical | ✅ critical → `escalateToTriage()` (execution_progress_stagnation) |
| M4 | `checkSessionEscalation` — sessionCount ≥5 | `logger.critical` | ✅ critical → `escalateToTriage()` → 直接 escalate human |
| M5 | `checkTotalExecutionTime` — >2.5h | `logger.critical` | ✅ critical → `escalateToTriage()` |
| M6 | `checkHeartbeatLoss` — >30min 无心跳 | `logger.critical` + kill tmux | ✅ kill 后 → `escalateToTriage()` |

**Monitor 6 项检查全部连通 Triage** ✅（Phase 1 FL-037 已实现 source→incidentType 映射）。

### Auditor Agent（已实现日审计 + 建议 + 反馈回路）

| # | 模式 | 当前状态 | 应实现 |
|---|------|----------|--------|
| A1 | 同 Agent 类型批量失败 | ✅ `escalateToTriage()` per-agent-type failureRate >30% | ✅ Phase 3 |
| A2 | Pipeline 完成率 | ✅ `escalateToTriage()` pipeline_health_degraded <50% | ✅ Phase 3 |
| A3 | 模型 tier 成功率 | ✅ `saveTierStats()` → DecisionAudit → `assessTaskComplexity()` 加载 | ✅ B3-005 |

### Triage Agent（✅ Phase 1 完成，已接入执行级事件）

`TriageIncidentInput` 类型已扩展为 10 种（4 系统级 + 6 执行级），执行级 action/diagnose 已实现。剩余：

**Monitor 升级 → Triage（✅ 已实现 5 条路径）**：
- ✅ `execution_repeated_failure` — 同步骤失败 ≥3 次
- ✅ `execution_stuck` — 执行卡住 >30min
- ✅ `execution_heartbeat_lost` — 心跳丢失
- ✅ `execution_session_exhausted` — 会话耗尽 ≥5 次（直接 escalate human）
- ✅ `execution_timeout` — 执行超时 >2.5h
- ⏳ `execution_progress_stagnation` — 进度停滞（M3，待 Phase 2 累计计数）
- ⏳ `review_cycle_exhausted` — 3 轮打回（Reviewer→Evolution 反馈回路，Phase 3）

**Auditor 升级 → Triage（新增 2 条路径）**：
- `agent_type_failure_trend` — 日扫描发现批量失败
- `pipeline_health_degraded` — 完成率下降 >30%

### Evolution Agent（已实现知识演化，缺执行反馈触发）

`evolution.service.ts`：三层演化（micro/meso/macro）+ decay check。当前只在 task failure 时触发，应扩展：

| # | 触发条件 | 当前 | 应改为 |
|---|----------|------|--------|
| E1 | Review 反复打回 ≥2 次 | 无 | 触发 evolution → 审查标准可能需要调整 |
| E2 | 同 pattern 错误跨 3+ Goal | 无 | 触发 evolution → 执行策略需要调整 |

### 静默失败 → 可见（先修基础设施）

以下 ~53 处静默失败需要先变成可见（log + event），才能被 Monitor/Auditor 检测：

| 静默类型 | 数量 | 修法 |
|----------|------|------|
| `catch {}` 空块 | ~25 处 | 替换为 `catch (e) { logger.error(...) }` |
| fire-and-forget 无 `.catch` | ~10 处 | 加 `.catch(err => logger.error(...))` |
| 仅 `logger.warn` 无 event | ~15 处 | warn 的同时 `eventBus.publish()` |
| 部分状态不一致 | 3 处 | 加事务/补偿逻辑 |

### 实施优先级

```
Phase 1: Monitor 升级路径 ✅ (2026-05-14 完成)
  ├─ ✅ 扩展 TriageIncidentInput.type 加 6 种执行级事件
  ├─ ✅ Monitor.check() 中 critical 级 alert → triageAgent.handleAlert() (escalateToTriage)
  ├─ ✅ TriageAgent 执行级 action commands + diagnose + session_exhausted 直接 escalate
  └─ ✅ Triage error-class.ts 加 6 条执行级分类规则

Phase 2: 静默 → 可见（让故障不再被吞掉）✅ (2026-05-14 完成)
  ├─ 31 silent catch blocks → logger.error (19) / logger.warn (12)
  └─ 16 files, 89 files / 750 tests pass

Phase 3: Auditor + Evolution（跨执行模式）✅ (2026-05-14 完成)
  ├─ ✅ Auditor 加 agent 类型/tier/完成率 三维分析
  ├─ ✅ Auditor 加升级路径 → Triage（>30% per-type / <50% overall）
  ├─ ✅ Evolution 加 Review 打回/跨 Goal pattern 触发
  ├─ ✅ Monitor M3 升级 critical → Triage 自动升级
  ├─ ✅ Triage 3 新事件类型全覆盖（11 种 total）
  └─ ✅ error-class 3 新分类规则
```

---

---
## 附录 A：旧架构历史记录

旧 roadmap 中已完成的工作（harness 集成、Goal 架构转型、Phase 1-7、Superpowers 铁律等）保留在 git 历史中（`git log --oneline` 查看 17 commits, 53 tests）。

关键成就：
- Goal-driven 架构完全替代 Workflow
- 7 Agent 角色体系（RoleConfig + 进化通路）
- harness 13 子系统全集成
- 全链路闭环（Trace/审计/Wiki/Reviewer/KK）
- Discord INF-001 连通
- 死代码清理 ~5000 行

---

## 附录 B：设计文档索引

| 文档 | 内容 |
|------|------|
| `DESIGN.md` | 设计总纲 |
| `ui-channel-flow-gaps.md` | 43 断点全量追踪 |
| `discord-integration-design.md` | Discord 集成 + 斜杠命令远程控制 |
| `workspace-daemon-design.md` | Workspace + Daemon |
| `triage-agent-design.md` | Triage Agent + errorClass |
| `auth-access-control.md` | Lurk Wall |
| `token-economics.md` | Token 分离 |
| `agent-first-design-2026-05-06.md` | Agent-First 架构讨论记录 |
| `agent-first-refactoring.md` | 39 Tools + 4 MCPs + 8 Skills |

---

## 十一、全量待办（2026-05-14 终版）

### A. 基础设施 CRITICAL（Harness S1-S4）

| # | 项 | 影响 |
|:--:|------|------|
| S1 | ConstraintChecker 单例无多请求隔离 | 并发项目配置污染 |
| S2 | SessionManager 状态跨请求丢失 | 每个 HTTP 请求 new 实例 |
| S3 | FailureRecorder 实例化缺必需参数→crash | new FailureRecorder() 无参调用即崩 |
| S4 | ConstraintViolationError 4 种不一致行为 | 同一异常不同路径处理不同 |

### B. 数据源打通（pipeline-⑨ 为瓶颈）

| # | 断点 | 说明 | 阻断 |
|:--:|------|------|------|
| ⑨ | harness trace 从未写入 | afterAgentComplete/afterReview hook 只有 TODO 注释 | 阻断 ⑯⑰⑱⑲ 四个断点 |
| ① | DiscussionDriver 不加载公司知识 | Analyst 入口缺上下文 | 下游决策不完整 |
| ③ | RequirementsDoc 跳过 LLM 聚合 | 简单 1:1 映射替代设计意图的 LLM 聚合 | Goal 规划质量 |
| ⑤ | 单 AC 组仍创建冗余 integration step | 浪费完整 execution cycle | 管线效率 |

### C. 工程拆分（IMPL-009→010→015→016 链）

| # | 项 | 状态 | 依赖 |
|:--:|------|:--:|------|
| IMPL-009 | Toolbox npm 包（adapter 注入，6 tools, DBAdapter 接口） | ✅ done | — |
| IMPL-010 | MCP Server（JSON-RPC 2.0, stdio/HTTP, whitelist, rate-limit） | ✅ done | IMPL-009 |
| IMPL-015 | 公开仓库 `dommaker/studio-toolbox` | ✅ done (https://github.com/dommaker/studio-toolbox) | IMPL-010 |
| IMPL-016 | npm publish CI（GitHub Actions, Node 20+22, publish on v* tag） | ✅ done | IMPL-015 |

### D. 质量闭环（2026-05-15 完成）

| # | 断点 | 状态 |
|:--:|------|:--:|
| ⑯ | Skill 有效性追踪 (BP-016) | ✅ trackSkillOutcomes（） in goal.service.ts |
| ⑰ | Auditor 因果分析验证 (BP-017) | ✅ SuggestionFeedback via auditor_suggestion cards |
| ⑱ | 跨并行 Executor 实时识别 | ✅ detectCrossExecutorErrors（） in trace-pipeline.service.ts |
| ⑲ | 立场有效性追踪 (BP-019) | ✅ stance data captured in afterReview trace |
| ⑦ | Skill 提取→published 无人审批 | ✅ pending proposals push to #系统 channel |
| ⑧ | 知识→角色回流无代码 | ✅ approved skills auto-add to executor/developer roles |

### E. 第一性分析发现的新卡点（M1-M6, 2026-05-15 完成）

| # | 卡点 | 状态 |
|:--:|------|:--:|
| M1 | Agent 冷启动耗时 | ✅ dispatchDurationMs logged in GoalScheduler |
| M2 | RequirementsDoc→Goal 质量门 | ✅ quality gate modal (M2) in RequirementsDocCard |
| M3 | GoalScheduler 决策日志缺失 | ✅ dispatch decision log (tier, constraints, context) |
| M4 | 审批界面不完整 | ✅ DeployApprovalCard + auditor_suggestion cards |
| M5 | 单 AC 组冗余 integration step | ✅ skip logic in goal-scheduler.ts:583-589 |
| M6 | daemon session 缓存命中率 | ✅ getCacheHitRate() in session-manager.ts |

### F. 工程瘦身（2026-05-18 审计确认）

| # | 项 | 状态 |
|:--:|------|:--:|
| D1 | `@dommaker/studio-organization` 零引用死包 | ✅ 已删（审批链分析：无功能需吸收） |
| D2 | `@dommaker/studio-workflow` 零引用死包 | ✅ 已删（Goal 架构替代） |
| D3 | `@dommaker/studio-backup` 仅 1 处引用 | ✅ 已删（PG→SQLite, cp 替代） |
| D4 | runtime-proxy 模块下线 | ✅ iron-laws→harness/routes, 模块目录已删除 |
| D5 | studio-shared 零消费者清理 | ✅ KnowledgeService/ContextService/AgentService 已删除 |

### G. 过期配置/文档（2026-05-18 审计确认）

| # | 项 | 状态 |
|:--:|------|:--:|
| C1 | `.env.production` REDIS_URL 未注释 | ✅ 已清理 |
| C2 | `.env` 文件含 `WS_HEARTBEAT_INTERVAL` | ✅ 已清理 |
| C3 | `AGENT_RUNTIME_URL` 残留在 5 个文件 | ✅ 已清理 |
| C4 | FAQ.md 100% 过时 | ✅ 已删除 |
| C5 | README.md 列 `@dommaker/workflows` | ✅ 已标记为"已移除" |
| C6 | architecture-validator 硬编码已废弃包名 | ✅ 已移除 dead package 引用 |
| C7 | ui-channel-flow-gaps.md | ✅ 已标注 |

### H. INF 项（2026-05-18 审计确认）

| # | 项 | 状态 |
|:--:|------|:--:|
| INF-001 | cloudflared tunnel | ✅ TryCloudflare + cron 自动更新 Discord endpoint |
| INF-002 | 动态规划 Part B | ✅ getSiblingContext() + siblingAdvice pipeline |
| INF-003 | 语义冲突检测 | ✅ buildIntegrationPrompt() with @sibling notes |
| INF-004 | 策略切换 | ✅ getDispatchStrategy() + conservative mode |
| INF-005 | DNS 迁移子任务 | ⏳ 等域名购买 |

### I. B4 远期（等数据积累）

| # | 项 | 触发条件 |
|:--:|------|------|
| B4-001 | 系统级 GC | Auditor ≥1 月 |
| B4-002 | GoalTemplate | KK ≥20 Goal |
| B4-003 | Agent→Tool 自动化 | Skill ≥10 |

### J. Spec（2026-05-18 审计确认）

| # | 项 | 状态 |
|:--:|------|:--:|
| SPEC-1 | company-knowledge-base | ✅ Document model + API + UI + auto-generation |

---

### 执行顺序（第一性推导）

```
Phase A: 修基础设施 CRITICAL → 管线可信
  S1-S4 (ConstraintChecker/SessionManager/FailureRecorder/ConstraintViolationError)

Phase B: 打通数据源 → 反馈回路有据可依
  pipeline-⑨ harness trace 写入 (填 hook TODO)

Phase C: 工程出口 → 系统可被外部使用
  IMPL-009 Toolbox → IMPL-010 MCP Server → IMPL-015 公开仓库 → IMPL-016 npm CI

Phase D: 质量闭环 → 基于 trace 数据补反馈
  pipeline-①⑧⑯⑰⑱⑲ 等

Phase E: 瘦身 + 远期
  死包清理 → B4

Phase F: Agent 行为约束（Mnilax 12 规则）
  5 新建 guideline + 2 增强 promptInjection + injectPrompt 标记
```

| Phase | 内容 | 状态 |
|:-----:|------|:--:|
| A (Harness bug) | S1-S4 CRITICAL | ✅ done |
| B (Trace) | ⑨ pipeline + ①③⑤ audit | ✅ done |
| C (公开仓库) | IMPL-009→010→015→016 | ✅ done |
| D (质量闭环) | ⑯⑰⑱⑲⑦⑧ | ✅ done |
| E (瘦身+B4) | D1-D5 + C1-C7 + M1-M6 + INF + SPEC-1 | ✅ done |
| F (Mnilax 吸收) | 5 guideline + 2 增强 promptInjection | ✅ done |
| G (Multi-Agent Harness) | G2工具风险 + G4轨迹评估 + G5动态路由 | ✅ done |
| H (知识库缺口) | G-001~005: 偏好/规则/环境/决策链/交互模式 + EvalCase | ✅ done |
| I (Slim Down) | 旧范式清理: -16 pages, -8 modules, -5 packages | ✅ done |
| J (Package 简化) | 删 4 僵尸包, 合 5 个到 apps/api: 17→8 packages | ✅ done (2026-05-19) |
| K (知识缺口审计) | B6-001~023: P0 源头捕获 + P1 冷启动 + P2 新鲜度自治 + P2.5 质量闸 + P2.5b 消费者闭环 | ✅ done (2026-05-23) |

---
### Phase H：知识库五大缺口 (2026-05-19)

设计文档：`docs/knowledge-gaps-design.md`

```
Phase 1 (当前): Schema + 基础提取 ✅
  ├─ S1: Prisma schema — 5 个新 model (UserPreference, BusinessRule, EnvironmentSnapshot, DecisionChain, InteractionPattern)
  ├─ S2: PreferenceObserver — MCP traces → UserPreference 增量 EMA 更新
  ├─ S3: RuleScanner — 冷启动静态扫描 → BusinessRule (harness constraints + .architect + 源码常量 + .env)
  └─ S4: EnvSnapper — 启动快照 + 24h 定时 → EnvironmentSnapshot

Phase 2: LLM 提取 ✅ (2026-05-19)
  ├─ S5: DecisionChainExtractor — Meeting end → DecisionChain + eventBus listener
  ├─ S6: KnowledgeAgent 扩展 — Goal 执行 → DecisionChain (架构变更检测)
  └─ S7: PatternMiner — 日度工具序列分析 → InteractionPattern + evolution-scheduler

Phase 3: 检索 + 注入
  ├─ S8: KnowledgeKeeper 扩展 — 5 种类型的 query 方法
  ├─ S9: Harness prompt injection — 偏好 + 规则 + 环境
  ├─ S10: #系统 Channel — 决策链确认卡片 + 模式洞察推送
  └─ S11: KnowledgePage 前端 — 新增 5 种类型浏览/搜索
```

### 知识类型对齐矩阵

| 类型 | 来源 | 存储 | 提取方式 |
|------|------|------|----------|
| preference (G-001) | PreferenceObserver | UserPreference | 统计+EMA |
| business_rule (G-002) | RuleScanner | BusinessRule | 静态扫描+diff |
| environment (G-003) | EnvSnapper | EnvironmentSnapshot | 系统调用 |
| decision_chain (G-004) | DecisionChainExtractor | DecisionChain | LLM |
| interaction (G-005) | PatternMiner | InteractionPattern | 统计分析 |
| eval_case | EvalCaseGenerator | KnowledgeEntry (type=eval_case) | Auditor dailyAudit |

---
### Phase I：Slim Down (2026-05-19)

旧范式（虚拟公司）模块清理：

| 类别 | 删除内容 |
|------|---------|
| 前端页面 (16) | Assessments, Backups, Conflicts, Dashboard, DataBoard, FinanceCenter, Issues, MeetingList/Detail, MultiStanceReviewDemo, OfficeArea, Promotions, ToolStdEdit/List/Versions, Home-backup |
| API 模块 (8) | economy, promotions, assessments, issues, dashboard, backups, tasks, workflows |
| Packages (5) | studio-economy, studio-accountability, studio-assessment, studio-organization, studio-workflow |
| E2E specs (27) | All browser-based e2e tests (Playwright), replaced by vitest |

保留: 14 pages, 29 modules, 10 packages (studio-prisma, studio-shared, studio-agent, studio-task, studio-role, studio-notification, studio-audit, studio-capability, studio-spec, studio-monitor). studio-meeting 已删除(2026-05-20)。

---
### studio-toolbox 审计 (2026-05-20 更新)

**安全**: 无硬编码密钥/Token、无个人信息、MIT license。通过。

**完整性**: ⚠️ 32 tools 定义，但 10 个引用已删除的模型（Meeting/ExecutionPlan 已删），需清理。

| 分类 | 工具数 | 状态 |
|------|:--:|:--:|
| PMO | 3 | ✅ |
| Knowledge | 5 | ✅ |
| Roles | 2 | ✅ |
| Tasks | 5 | ✅ |
| Meetings | 6 | ❌ 死（Meeting 模型已删除） |
| Spec | 4 | ✅ |
| Agent | 4 | ❌ 死（ExecutionPlan/ExecutionResult 已删除） |
| Constraint | 3 | ✅ |

**待清理**: 删 10 个死 tool → 22 tools。
**待接入**: AgentExecutor 执行时不加载 toolbox tools，tool 定义独立存在但未进入执行管线。

---

### Harness 飞轮说明

方案A（当前）: `scripts/sync-harness.sh` 手动同步 harness dist → agent-studio node_modules。worktree init 从 agent-studio 的 `.harness/` 复制配置。缺点：硬编码本地路径，不是自动化的。

方案B（等全部公开后）: harness npm publish → agent-studio pnpm update → 自动感知。优点：标准 npm 流程，无本地路径依赖。

---

### 当前待办 (2026-05-20 — P0 吃狗粮闭环完成)

| 优先级 | 项 | 状态 | 预估 |
|:--:|------|:--:|:--:|
| **P0.1** | **Knowledge S9 — Agent 提示注入** | ✅ | 2h |
| **P0.2** | **KK→Analyst 反馈回路** | ✅ | 1h |
| **P0.3** | **Tool 模式检测** | ✅ | 1.5h |
| **P0.4** | **Goal 卡住自动恢复** | ✅ | 0.5h |
| **P0.5** | **管线完成总结卡片** | ✅ | 0.5h |
| **P0.T** | **管线可追溯 (traceId + PipelineRun + AuditLog)** | ✅ | 2h |
| P1 | studio-toolbox 死 tool 清理 | ✅ | 0.5h |
| P1 | Skill 系统 | ✅ | 3h |
| P1 | routes.ts:287 字面量 bug 修复 | ✅ | 0.1h |
| -- | **2026-05-21 完成** | -- | -- |
| P0 | Ops Agent + Pre-flight Guard | ✅ | 3h |
| P0 | 配置加载修复 (index.ts loadConfig) | ✅ | 0.5h |
| P0 | AuthModal 硬编码邮箱修复 | ✅ | 0.5h |
| P0 | Cloudflared 管理 + CLOUDFLARED_ENABLED 守卫 | ✅ | 0.5h |
| P0 | 故障报告 (7 incidents → incidents.jsonl) | ✅ | 0.5h |
| P0 | C1: 状态机类型守卫 (GoalStatus transitions) | ✅ | 0.5h |
| P0 | M4: env 文档 (8 缺失变量) | ✅ | 0.2h |
| P0 | M1: 健康端点 GET /api/v1/health | ✅ | 0.5h |
| P0 | H2: Ops rules 数据化 (ops-rules.json) | ✅ | 1h |
| P0 | C2: Worktree GC (7d cleanup) | ✅ | 0.5h |
| P0 | H1: 知识总线 + H3: Monitor→Bus + H4: Triage→Bus | ✅ | 2h |
| P0 | harness: no_fallback_without_root_cause guideline (^0.12.3) | ✅ | 0.5h |
| P0 | 狗粮 bug 修复 (parser AC 组解析, JSON.parse, import path, branch, task.prompt) | ✅ | 3h |
| -- | **以下待做** | -- | -- |
| **P0** | **后评估 Agent (PostEvalAgent)** — 对比计划 vs 实际，发现遗漏 | ✅ | 2h |
| **P0** | **Reviewer: 多立场审查增加 fallback/hack 检测 (forensic 第5立场)** | ✅ | 1h |
| P0.E | analyst-trigger import 路径修复 | ✅ | 0.1h |
| -- | **RequirementsDoc 质量门 (当前 P0)** | -- | -- |
| P0 | RequirementGate: 纯代码检查 (AC≤6, path存在, deps闭环) | ✅ | 1h |
| P0 | RequirementGate: flash LLM 语义验证 (AC独立, 隐式依赖, 文件冲突) | ✅ | 1h |
| P0 | Gate 不通过 → Channel 反馈 → Analyst 修正 → 重新提交 | ✅ | 0.5h |
| -- | **Agent 上下文统一** | -- | -- |
| P0.A | 新建 forensic-review + tool-risk Skill | ✅ | 0.5h |
| P0.B | buildAgentContext() 统一入口 | ✅ | 1.5h |
| P0.C | 实时进度推送 (Agent → Channel progress cards) | ✅ | 1h |
| P0.D | 管线状态仪表板 (GET /api/v1/pipeline/status) | ✅ | 1h |
| P0.E | AC Parser 重构 B1~B6 + RequirementGate 多 root 路径 | ✅ | 2h |
| P0.F | 生产服 systemd + pre-commit 凭证扫描 + harness no_hardcoded_credentials | ✅ | 1h |
| P0 | 狗粮多步 Goal 调试 (集成/审查/部署/KK 全链路) | 待做 | 4h |
| **P1** | **审查/部署结果持久化到 DB** | 待做 | 2h |
| -- | **2026-05-24 管线自举** | -- | -- |
| P0 | 管线自举: harness trace 写入 (pipeline-⑨) | ✅ | Pipeline 全链 |
| P0 | Q1: Reviewer 未触发→blocked | ✅ | goal.service |
| P0 | Q2: Integration 竞态修复 | ✅ | goal.service |
| P0 | Q6: 数据库路径绝对化 | ✅ | index.ts |
| P1 | Q5/Q3/Q4/Q7/Q8 + R4: 5个效能+session共享 | ✅ | scheduler/analyst/executor |
| P1 | **R3: 模型 tier 动态路由生效** (classifyTaskComplexity→agentExecutor) | ✅ | goal-scheduler.ts |
| P1 | **Q3a: Analyst 依赖分析 prompt 升级** (dependencies 种群) | ✅ | analyst-trigger.service.ts |
| -- | **待实现: 信息保真度优化** | -- | -- |
| P1 | **架构上下文注入**: Analyst→Executor 传递函数签名+行号+调用链 | ✅ | ~80行 analyst-trigger + agent-executor |
| P1 | **实现技巧复杂度分级**: classifyTaskComplexity 增加 skill 维度 | ✅ | ~30行 goal-scheduler |
| P1 | **Analyst 准确率反馈闭环**: PostEval 归因 → KnowledgeBus → prompt 反射 | ✅ | post-eval/knowledge-bus/analyst-trigger |
| P1 | ~~direct-executor: Analyst→Executor 同 session~~ **→ 取消。架构上下文注入 + 技能分级已消除 95% 浪费，合并仅省 ~15s session 启动，不值得新增管道复杂度** | 取消 | — |
| P1 | **知识沉淀: docs/*.md 自动摄入** — PostToolUse hook 已就位(检测 `ingest:true` → log)，全自动调用 MCP 需 local-rag HTTP endpoint 或 KnowledgeSync 管道 | ⚠️ 半自动 | .claude/settings.json |
| P1 | daemon 远程注册 + 远程分发 + 算力 UI | 待做 | 5d |
| P2 | Agent 记忆模型 | 待做 | — |
| P2 | Discord webhook 多身份 + @Agent 自由格式 | 待做 | — |
| P2 | Agent 人设注入 (RoleConfig.systemPrompt → 运行时) | 待做 | 1h |
| P2 | Skill DB 驱动加载 (替换硬编码 definitions/index.ts) | 待做 | 2h |
| P2 | Skill 定义扩展: tools/required/autoLoad 字段 (#74) | 待做 | 1h |
| P2 | Skill 事件触发自动加载 — agent-event-listener 绑定 trigger→load (#75) | 待做 | 1.5h |
| P2 | Skill 加载/卸载生命周期 — load 注入 prompt+tool, unload 回收 (#76) | 待做 | 2h |
| P2 | Skill ↔ Tool 权限绑定 — tier 控制 fast/standard/premium (#77) | 待做 | 1.5h |
| P2 | SkillProposal 端到端审批工作流 — 提案→审批→创建 Skill (#78) | 待做 | 1.5h |
| P2 | S-001: 统一 Skill schema — 合并 SkillDefinition/Prisma Skill/CompanySkill 三套字段 | 待做 | 2h |
| P2 | S-002: buildSubAgentPrompt() 收归 buildAgentContext() 统一入口 | 待做 | 1h |
| P2 | S-003: Execution 反馈闭环 — POST /skills/usage 接入执行管线 | 待做 | 1h |
| P2 | S-004: Unload 架构重设计 — 结构化作用域替代持久文本注入 | 待做 | 2h |
| P2 | S-005: Evolution 闭环 — Auditor 报告 → 运行时 SkillDefinition 更新 | 待做 | 2h |
| P2 | S-006: Cross-Agent DB→runtime 回路 — CompanySkill 接入 SkillLoader | 待做 | 1.5h |
| P3 | INF-005 DNS | 阻塞 | — |
| P4 | B4-001/002/003 远期 | 远期 | — |
| -- | **Batch 6: 知识缺口审计 (2026-05-22)** | -- | -- |
| **P0** | **B6-001** extractFromReview — ReviewResult → LLM → ingestEntry | ✅ | 1h |
| **P0** | **B6-002** extractFromError — error+errorChain → pitfall 条目 | ✅ | 0.5h |
| **P0** | **B6-003** extractFromCompletion — completionOutput → LLM 提取 | ✅ | 0.5h |
| **P0** | **B6-004** extractFromDeploy — DeployAgent 发现 → LLM 提取 | ✅ | 0.5h |
| **P0** | **B6-005** cstnew → cst-emit.sh session:archive 事件发出 | ✅ | 0.2h |
| **P0** | **B6-006** events-daemon session:archive 路由 → POST Studio API | ✅ | 0.5h |
| **P0** | **B6-007** POST /api/knowledge/extract-session 端点 | ✅ | 0.5h |
| **P0** | **B6-008** KnowledgeAgent.extractFromSession() JSONL→LLM→ingest | ✅ | 2h |
| **P0** | **B6-009** 排查 ingestEntry 去重失效原因 | ✅ | 0.5h |
| **P0** | **B6-010** 修复去重 + dedup log | ✅ | 0.5h |
| **P1** | **B6-011** 弃用 project_4_agent_system.md | ✅ | 0.1h |
| **P1** | **B6-012** 弃用 project_new_architecture_gaps.md | ✅ | 0.1h |
| **P1** | **B6-013** 标记 issue_studio_harness_context_integration.md 为 SUPERSEDED | ✅ | 0.1h |
| **P1** | **B6-014** 创建 project_batch_progress_2026_05_22.md | ✅ | 0.2h |
| **P1** | **B6-015** harness types.ts 加 architecture 类型 + system 层 | ✅ | 0.2h |
| **P1** | **B6-016** KnowledgeAgent.coldStartAll() 四源导入 | ✅ | 1.5h |
| **P2** | **B6-017** KnowledgeQuery 引用追踪 — query() 更新 lastReferenced | ✅ | 1h |
| **P2** | **B6-018** KnowledgeDoctor.healthScore() — 创建 harness/src/knowledge/doctor.ts | ✅ | 1.5h |
| **P2** | **B6-019** MonitorAgent.check() 扩展 — healthScore+decay+autoFix | ✅ | 1.5h |
| **P2** | **B6-020** G-003 EnvSnapper.start() 验证连通 | ✅ | 0.2h |
| **P2** | **B6-021** G-004 DecisionChain extractFromExecution 验证 | ✅ | 0.2h |
| **P2** | **B6-022** KnowledgeBus 多写入者 — Auditor/PostEval/Deploy | ✅ | 1h |
| **P2** | **B6-023** ReviewAgent → KnowledgeBus recordPattern | ✅ | 0.5h |

---

## 十二、2026-05-20 审计：已实现 vs 未实现

### 已实现 ✅（管线完整可用）

**核心管线**：
- @Analyst → RequirementsDoc → Goal → GoalPlan → GoalExecutions → AgentExecutor
- AgentExecutor: spawn claude, git worktree, session loop, .progress.json, 策略切换
- Reviewer: 多立场审查 → handleGoalSucceeded（放行/打回/escalate, max 3 轮）
- KK: 知识提取 + @human 确认卡片
- Deploy: SQL/依赖变更检查，接入 finalizeGoalSucceeded

**基础设施 Agent**：
- MonitorAgent: 6 项检查 + escalateToTriage ✅
- AuditorAgent: 日审计 + 3D 分析 ✅
- TriageAgent: errorClass 8 类 + 11 种事件 ✅
- Evolution: decay + meso + recordReviewRejected ✅

**UI**：
- Channel 列表/详情 + @mention 自动补全 + SSE 实时 ✅
- 结构化卡片（RequirementsDoc/Goal/Review/Knowledge） ✅
- 通知中心（铃铛 + 标题闪烁 + @human 路由） ✅
- Lurk Wall + AuthModal ✅
- LLM Wiki（全文搜索 + [[双向链接]] + 图谱） ✅

**集成**：
- Harness: 10/10 hooks Active, 2 blocking ✅
- Knowledge Gaps G-001~005: 5 模型 + 5 提取器 ✅
- Discord: 斜杠命令 + /studio run + 通知 ✅
- MCP: Server + Permission + ToolRegistry ✅
- Daemon: Analyst+Reviewer 常驻 session, --session-id 持久化 ✅

**工程清理**（2026-05-20）：
- Meeting 模块 + studio-meeting 包删除（-27 文件, -7 Prisma 模型） ✅
- System A 游戏层剥离（-9 Prisma 模型, -8 文件, -13 死包/模块） ✅
- 设计文档同步到 studio/docs/（18 文件） ✅
- Phase A-J 全部完成 ✅

### 未实现 ❌（设计有、代码无）

| # | 缺口 | 设计文档 | 影响 |
|---|------|---------|------|
| 1 | **daemon 远程注册** | workspace-daemon-design.md | 只支持单机执行 |
| 2 | **算力节点加入 UI** | workspace-daemon-design.md §三 | 无法加入其他电脑 |
| 3 | **远程任务分发** | deployment-design.md §C | GoalScheduler 只调本地 |
| 4 | **studio-toolbox 接入** | agent-first-refactoring.md | tool 定义了但不加载 |
| 5 | **Skill 系统** (12 项缺口: #72~#78 + S-001~S-006) | agent-first-refactoring.md §8 Skills | 硬编码/无生命周期/无工具绑定/无审批流/无反馈闭环 |
| 6 | **Agent 记忆模型** | agent-first-design-2026-05-06.md | 无 3 层记忆 |
| 7 | **Knowledge Phase 3** | knowledge-gaps-design.md §S9,S11 | 提取了未注入/未展示 |
| 8 | **Discord webhook 多身份** | discord-integration-design.md | 不能换 username |
| 9 | **Discord @Agent 自由格式** | discord-integration-design.md | 只处理斜杠命令 |
| 10 | **Skill 自动加载事件** (→ #75) | agent-first-design IMPL-011 | 无事件驱动 |

### 部分实现 🔶

| # | 项 | 缺什么 |
|---|------|--------|
| 1 | Discord 远程控制 | /studio 命令部分实现，缺 forward/sync |
| 2 | Tool 模式检测 | TracePipeline 运行但不检测 3 种具体模式 |
| 3 | Hybrid Agent LLM 能力 | Auditor/Triage/Deploy 纯代码，缺 LLM 解读 |
| 4 | Triage 全局横幅 | 设计有，代码未确认 |

---

## 十三、P0 吃狗粮闭环 (2026-05-20)

### 第一性推导

```
现在：一个人，一台 VPS，用 studio 开发 studio

优先级 = 哪个能力对下次开发最有帮助？
  算力分布式 → 零收益（只有一台机器）
  Skill 系统  → 中收益（能复用，但还没有积累）
  知识注入   → 高收益（Agent 了解上下文，不每次从零探索）
  失败检测   → 高收益（Agent 卡住、反复失败能立刻知道）

结论：先把 Agent 变聪明 → 再让 Agent 能复用 → 最后加机器
```

### P0.1: Knowledge S9 — Agent 提示注入

**本质**：Agent 执行时自动加载偏好、业务规则、环境快照、历史决策。

**当前状态**：
- 5 种知识已提取（G-001~005），格式方法已实现（`formatForPrompt()`）
- AgentExecutor `buildPrompt()` **零知识注入**
- GoalScheduler 注入了紧凑版（`formatCompactForPrompt`）但 Agent 重建 prompt 时丢失
- Analyst 只读本地文件 `.analyst/knowledge.md`，不查 DB 知识库

**改动点**：

| 文件 | 改动 |
|------|------|
| `agent-executor.ts:buildPrompt()` | 新增 `knowledgeContext` 参数，注入到 session 1 和 session 2+ prompt |
| `agent-executor.ts:execute()` | 调用 `knowledgeQuery.formatCompactForPrompt('executor')` 获取知识 |
| `analyst-trigger.service.ts:buildAnalystPrompt()` | 在 `loadKnowledge()` 后追加 `knowledgeQuery.formatAllForPrompt('analyst')` |
| `goal-scheduler.ts:dispatchStep()` | 已有注入，确认 session 2+ 不丢失（改 `buildPrompt` 后自然解决） |

**预期产出**：Agent 启动就知道用户偏好（模型、交互风格）、代码库规则、当前环境、历史踩坑记录。不再每次从零探索。

### P0.2: KK→Analyst 反馈回路

**本质**：KK 提取的 pitfall/pattern 自动被 Analyst 加载。

**当前状态**：
- KK 保存到 `KnowledgeStore` (harness) 和 Wiki (`pitfalls/*.md`)
- Analyst 只读 `.analyst/knowledge.md`（本地文件）
- 两个数据路径**完全隔离**

**改动点**：

| 文件 | 改动 |
|------|------|
| `knowledge-query.service.ts` | 新增 `queryPitfallsForAnalyst()` 方法，查询最近 pitfall/pattern |
| `analyst-trigger.service.ts:204` | `loadKnowledge()` 后追加 DB 查询，合并到 prompt 的"历史分析积累" |
| `knowledge-agent.service.ts:extract()` | 确认存入 `knowledgeQuery` 可查询的路径（harness KnowledgeStore 已在用） |
| `goal.service.ts:assessTaskComplexity()` | 已有 `decisionAudit` 查询 — 确认 KK 存入的 tier 数据在这里可读 |

**预期产出**：Analyst /plan 时提示"上次类似需求踩过 xxx 坑，建议用 standard tier 而非 flash"。

### P0.3: Tool 模式检测

**本质**：实时检测 Agent 工具调用的异常模式，3 次同样失败 → Channel 告警。

**当前状态**：
- `tool-registry.ts:recordCall()` 有内存统计 + 事件文件写入
- `pattern-miner.ts:analyzeDaily()` 每日批量分析，非实时
- `monitor-agent.service.ts:checkFailureTrend()` 检查任务级别失败，非工具级别
- 3 种具体模式（零调用/3 次失败/频率尖峰）全部缺失

**改动点**：

| 文件 | 改动 |
|------|------|
| `tool-registry.ts:recordCall()` | 新增实时检测：同一 executor 连续 3 次同 tool 失败 → publish event |
| `monitor-agent.service.ts` | 新增 `checkToolPatterns()` 方法，5min 轮询工具调用统计 |
| `monitor-agent.service.ts:check()` | 把 `checkToolPatterns()` 加入轮询周期 |

**预期产出**：Agent 反复调用同一个失败的工具 → Monitor 检测到 → 推 Channel → 你立刻知道 Agent 卡住了。

### P0 执行顺序

### P0.4: 管线全阶段日志补齐 + Token 拆分 + Plan Coverage ✅ (2026-05-22)

全部管线阶段监控完成 + model-gateway cacheHit 拆分 + PostEval plan 覆盖率验证。

### P0.5: 知识沉淀基础设施 ✅ (2026-05-22)

KnowledgeSync(自运转)、电路自检+自愈(因果推断)、设计时沉淀(upsert+scope去重)、新鲜度检测(git对比)、API+CLI。

### P0.6: 约束 Prompt 注入 ✅ (2026-05-22)

harness 26 条约束的 promptInjection 按 agent 角色路由到 Analyst/Executor/Integration/Reviewer 四个 prompt builder。

### P0.7: 知识断点 17→0 + 单例 Store ✅ (2026-05-22)

知识库全链路断点修复: BP-17 单例, BP-4 引用追踪, BP-2 lastReferenced 初始化, BP-1 成熟度分层。

### P0.8: 用户模型引擎 ✅ (2026-05-22)

Lenses(6)+Meta-Principles(4)+Derived Rules, analyze-sessions 纠正模式发现, update-user-model 增量演化, harness define→detect→learn 抽象。

### P0.9: Deep Analysis 检测 hooks ✅ (2026-05-22)

PostToolUse+Stop 组合: EnterPlanMode/Agent(Explore)/10+dirs Read → 未写 knowledge → Stop 时 warn。

### P0 执行顺序（已废弃，保留历史）

```
P0.1 知识注入 (2h)
  ├── analyst-trigger: 加 knowledgeQuery.formatAllForPrompt()
  ├── agent-executor: buildPrompt 加 knowledgeContext 参数
  └── 验证: 下次 @Analyst 时 prompt 里有偏好/规则/环境

P0.2 KK→Analyst 回路 (1h)
  ├── knowledge-query: 加 queryPitfallsForAnalyst()
  ├── analyst-trigger: loadKnowledge 后合并 DB 查询
  └── 验证: 下次 /plan 时看到历史 pitfall 提示

P0.3 Tool 模式检测 (1.5h)
  ├── tool-registry: recordCall 加 3x 失败检测
  ├── monitor-agent: 加 checkToolPatterns()
  └── 验证: 故意让 tool 失败 3 次 → Channel 收到告警
```

### 验证标准

全部做完后的"吃狗粮"流程：

```
1. Channel #研发 发: "@Analyst 给 studio 加个 X 功能"
2. Analyst prompt 里自动注入了:
   - preference: "你偏好 concise 风格，用 standard tier"
   - rule: "PORT 从 .env 读取，不硬编码"
   - pitfall: "上次改 agent-executor 时 session 2+ prompt 丢失了约束，这次注意"
3. Goal 创建 → Executor 执行
4. 如果 Executor 反复调用 createProject 失败 3 次 → Channel 收到告警卡片
5. KK 提取新 pitfall → 下次 @Analyst 自动加载
```

---

## Batch 7：知识进化引擎 E2E 修复 + Agent 拓扑解耦 + RKB Phase 1 (2026-05-23)

> 端到端测试知识进化引擎时发现三处断裂：events-daemon JSONL 解析器读错字段、modelGateway JSON 提取失败、KnowledgeIngest linter 崩溃。
> 同步完成 Agent 拓扑解耦：ReviewAgent.reviewDiff + DeployAgent.mergeBranches/pushBranch 参数化。
> RKB Phase 1：六层知识模型 L3~L5 基建完成 — Resolution Prisma 模型、匹配/创建/验证服务、agent-executor 失败注入、Auditor 自动检测、预置 seed。

### B7-001: events-daemon JSONL 解析修复

`parsed.content` → `parsed.message.content`（Claude v2 JSONL 格式变更）

| # | 改动 | 文件 |
|---|------|------|
| 1 | user/assistant 消息内容提取改为 `parsed.message?.content` | `/root/transport/events-daemon.js:86-98` |

### B7-002: events-daemon → API 路由修复

| # | 改动 | 文件 |
|---|------|------|
| 1 | API_PORT 3001 → 13101 | `/etc/systemd/system/events-daemon.service` |

### B7-003: modelGateway JSON 提取增强

| # | 改动 | 文件 |
|---|------|------|
| 1 | `extractBalancedJson()` 平衡括号提取替代贪婪正则 | `packages/studio-shared/src/llm/model-gateway.ts` |
| 2 | 多策略顺序: direct→codeblock→object→array | 同上 |
| 3 | Empty content 诊断日志 | 同上 |

### B7-004: Agent 拓扑无关能力

| # | 改动 | 文件 |
|---|------|------|
| 1 | `ReviewAgent.reviewDiff(baseRef, headRef, repoPath)` | `review-agent.service.ts` |
| 2 | `ReviewAgent.hasBranchChanges()` | 同上 |
| 3 | `DeployAgent.mergeBranches(source, target, push?)` | `deploy-agent.service.ts` |
| 4 | `DeployAgent.pushBranch(branch)` | 同上 |
| 5 | `DeployAgent.resolveRef()` — origin优先+本地fallback | 同上 |
| 6 | `mergeToMaster()` 修复 main→master 跳过 bug | 同上 |
| 7 | POST /review/diff, /deploy/merge, /merge-to-master | `agents/routes.ts` |
| 8 | `ReviewDiffParams`, `MergeBranchesParams`, `MergeBranchesResult`, etc. | `agents/types.ts` |

### B7-005: 文档/roadmap 自动更新缺口（已识别，未实现）

PostEval 阶段只做 AC vs diff 审计，不自动更新 docs/roadmap。导致每次 Deploy 后需要手动："更新文档 → 更新 roadmap → commit → push"。

**后续应做**: PostEval 或 Deploy 完成后自动:
1. 从 git diff 检测变更类型（feat/fix/chore）
2. 更新 memory docs / batch progress
3. 更新 roadmap 状态
4. Commit + push 文档变更

### B7-006: RKB Phase 1 — 运维配置类知识覆盖 (L3~L5)

> 第一性分析发现知识进化引擎只覆盖 L1(代码)+L2(偏好)，L3~L6(工具行为/环境配置/错误解法/跨会话因果)完全盲区。
> Phase 1 完成基建：Resolution 数据模型 + 匹配/创建/验证服务 + agent-executor 集成 + Auditor 自动检测 + 预置 seed。

| # | 改动 | 文件 |
|---|------|------|
| 1 | `Resolution` Prisma 模型 (pattern, errorClass, layer, title, fix, status, verifyCount) | `packages/studio-prisma/prisma/schema.prisma` |
| 2 | SQLite 迁移 | `migrations/20260523000000_add_resolution/migration.sql` |
| 3 | Resolution 类型定义 (L3/L4/L5/L6 layer, MatchResolutionResult) | `packages/studio-shared/src/types/resolution.ts` |
| 4 | `ResolutionService` — matchResolutions(两层:regex+子串), createResolution, verifyResolution, listPending, ensureSeedResolutions | `apps/api/src/modules/knowledge/resolution.service.ts` |
| 5 | 启动时 seed: root+dangerously-skip-permissions → canonical | `apps/api/src/index.ts` |
| 6 | agent-executor 失败时查 Resolution DB → 匹配则注入 retry prompt | `packages/studio-agent/src/services/agent-executor.ts` |
| 7 | Auditor 日审: 对未见过的运维类 error pattern 自动创建 pending Resolution | `apps/api/src/modules/agents/auditor-agent.service.ts` |
| 8 | 六层知识覆盖分析文档 | `memory/project_knowledge_engine_ops_gap.md` |

**六层覆盖状态 (Phase 1 完成后):**

| Layer | 覆盖 | 说明 |
|-------|:--:|------|
| L1 代码知识 | 100% | KK + Wiki + Evolution Service |
| L2 用户偏好 | 100% | PreferenceObserver (5 维度 EMA) |
| L3 工具行为 | 30% | RKB 基建完成，仅 1 条 canonical seed |
| L4 环境配置 | 30% | 同上，知识密度待积累 |
| L5 错误→解法 | 40% | 匹配+注入链路通，解法靠 seed+Auditor 自动检测 |
| L6 跨会话因果 | 0% | 需 EnvironmentSnapshot diff + DecisionChain 因果关联 |

**知识闭环：**
```
执行失败 → ErrorClassifier 归类
          → Resolution.match() 查已知解法 → 有: 注入 retry prompt
          → 无: 记录 error
                → Auditor 日审 → 新 pattern → 自动创建 pending Resolution
                → 人工回写 fix → verifyCount++ → canonical
```

**Phase 2 待做 (L6 + 知识密度):**
- L6 跨会话因果: EnvironmentSnapshot diff → 变更-故障因果链
- 知识密度: 每次手动解决运维问题后主动回写 Resolution
- Auto-verify: 同一 Resolution 被 match 并 success → 自动 verifyCount++
- RAG 互通: Resolution.canonical → 自动 ingest 到 local-rag

### B7-007: 开发文档 → KnowledgeStore 自动沉淀 (memory hook)

> 知识进化引擎只有一条自动输入源（Agent 执行会话），开发分析产出（memory/）完全断开。
> 新增 PostToolUse(Write) hook：memory/*.md 写完后自动同步到 KnowledgeStore (.harness/knowledge/)。

| # | 改动 | 文件 |
|---|------|------|
| 1 | `memory-knowledge-sync.js` — 解析 frontmatter ingest/maturity 门，写 KnowledgeStore 兼容格式 | `harness/bin/memory-knowledge-sync.js` |
| 2 | `memory-knowledge-sync.sh` — PostToolUse hook wrapper，从 stdin JSON 提取 file_path | `harness/bin/memory-knowledge-sync.sh` |
| 3 | settings.json 新增 PostToolUse(Write) hook → bash memory-knowledge-sync.sh | `~/.claude/settings.json` |
| 4 | 首批 3 文档标记 ingest:true + frontmatter 并同步 | `memory/project_knowledge_engine_ops_gap.md`, `analysis_auto_precipitate_expose.md`, `project_pipeline_flow.md` |

**内存成熟度门:**
```yaml
# memory 文件 frontmatter:
ingest: true       # 显式标记才触发
maturity: verified # draft 跳过，canonical 最高
```
PostToolUse(Write) 触发 → frontmatter 检查 → 写入 `apps/api/.harness/knowledge/` → Agent 通过 KK 可查询。

**知识输入源覆盖 (B7-007 后):**

| 输入源 | 状态 | 机制 |
|-------|:--:|------|
| Agent 执行会话 | ✅ | events-daemon → extract-text → LLM → sharedStore |
| 开发分析产出 (memory/) | ✅ | PostToolUse(Write) → frontmatter gate → KnowledgeStore |
| 设计文档 (docs/) | ❌ | 同机制可扩展，待标记 |
| RAG (local-rag) | ❌ | 手动 ingest，独立体系 |

---

## 十四、预存 TypeScript 错误 (2026-05-24 全量 baseline)

> 全量 tsc baseline 已建立：`bin/tsc-gate.sh` + `.tsc-baseline.json`。
> **234 个预存错误** 分布：apps/api(226) + studio-audit(2) + studio-notification(2) + studio-task(4)。
> 新错误在 pre-commit 处阻塞（baseline-aware gate），旧错误逐步清理。

### 按文件分布 (apps/api 前 15)

| 文件 | 错误数 |
|------|:--:|
| `roles/memory.service.ts` | 12 |
| `roles/role.service.ts` | 6 |
| `roles/routes.ts` | 2 |
| `discord/routes.ts` | 6 |
| `discord/discord-bot.ts` | 3 |
| `dingtalk/routes.ts` | 2 |
| `agents/routes.ts` | 1 |
| `audit-logs/routes.ts` | 1 |
| `auth/routes.ts` | 1 |
| `environments/routes.ts` | 1 |
| `executions/routes.ts` | 1 |
| `spec-reviews/spec-review.service.ts` | 2 |
| `tools-std/skill-extraction.service.ts` | 2 |
| `tools-std/skill-proposal-routes.ts` | 2 |
| ...其他 40+ 文件 | ~186 |
| **总计** | **226** |

### baseline 管理

```bash
bin/tsc-gate.sh --update-baseline   # 修完错误后更新基线
bin/tsc-gate.sh --all               # 全量检查
TSC_GATE_OFF=1 git commit ...       # 紧急跳过
```

### 备注

- 2026-05-23 首次曝光 10 个错误（手动快照，已腐烂）
- 2026-05-24 升级为自动化 baseline gate：234 个错误全量基线化 + pre-commit 增量检测

### 本会话新发现断点 (2026-05-24 更新)

| # | 断点 | 状态 | 说明 |
|---|------|:--:|------|
| G6 | 开发会话知识提取链路 | ✅ 已建 | session:summary → events-daemon → extract-text |
| G7 | 敏感文件操作检测 | ✅ 已建 | sensitive-check hook + Stop 警告 |
| G8 | Harness CI-RKB 闭环 | ✅ 已建 | pre-commit 警告 → resolutions.json 解法提示 |
| G9 | harness 狗粮噪音 | ✅ 已清 | 3 guideline warnings → 0, 1 checkpoint failure → 0, 4/4 pass |
| G14 | Auditor 吃 session:summary | ✅ 已建 | 日审新增开发会话行为趋势分析（deepAnalysis/knowledgeCapture/sensitiveOps/turnCount），产出门控洞察 |
| G10 | 六层知识模型 L3→L6 覆盖 | 🟡 部分 | L3/L4/L5 40% 基建完成，知识密度待积累；L6 0% |
| G11 | 11 个预存 tsc 错误 | ❌ 待修 | roadmap §14 曝光，等 pre-commit tsc gate 建立后逐个清 |
| G12 | 开发会话 behavior pattern → harness 进化 | ❌ 方案不可行 | 第一性分析结论：行为模式进化不应走 evolution service（检测信号/输出目标/执行机制三维不同）。正确方案：Auditor + session:summary 趋势洞察 → 人工决策。见 `memory/analysis_evolution_extension.md` |
| G13 | `knowledge-docs/` 目录空 | ❌ 用途不明 | 已分配但完全无内容，需明确设计意图或废弃 |
