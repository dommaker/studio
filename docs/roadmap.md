# Studio Roadmap — 唯一入口

> 最后更新：2026-07-02 (Agent Loop 重写完成 + SDD 生命周期设计决策)
> 架构文档：[specs/arch/index.md](specs/arch/index.md)
> OKR：[OKR/](OKR/)
> 分支：仅 master，无活跃功能分支

---

## 当前开发计划

基于 [modules.md](specs/arch/modules.md) Implementation Order。四阶段：手动基础 → S3 门控 → 管线自举 → 管线驱动。

### Phase 0-3: 手动开发（不依赖管线）

KnowledgeService 是基础设施，所有后续模块通过它访问知识。

| Phase | 模块 | 内容 | 产出 | 状态 |
|-------|------|------|------|------|
| P0 | Module 10 | KnowledgeService 接口定义 | 6 大能力方法签名，纯接口不改行为 | ✅ 完成 |
| P1 | Module 10 | 能力吸收到 KnowledgeService | KnowledgeBus/resolutionService/prompt-builder/Monitor/KnowledgeAgent/EvolutionService 中的知识逻辑迁入 | ✅ 完成 |
| P2 | Module 10 | Agent 迁移 | review/triage/post-eval 已迁移，channels/scheduler 仍用 buildKnowledgeContext（非 Agent 层） | ✅ 完成 |
| P3 | Module 9 | Platform | KnowledgeStore interface + HTTP API + SSE + KnowledgeService HTTP API | ✅ 完成 |

### Phase 3.1-3.4: S3 门控（必须全部通过才能进入管线自举）

| Phase | 内容 | 根因 | 状态 |
|-------|------|------|------|
| 3.1 | Skill .md 迁移 + metadata+index 消费模型（skill-loader 双读 + formatForPrompt 返回索引 + loadSkill MCP tool） | 能力载体层已设计未实施 | ✅ 完成 |
| 3.2 | PipelineRun goalId + 事件补全（conflict/deploy） | 缺关联层 | ✅ 完成 |
| 3.3 | 反馈层核心（extractFromExecution + recordOutcome + pipelineStepFeedback）+ failure 路径补全 + recordKnowledgeRefs 接入 scheduler-dispatch | 缺反馈层 | ✅ 完成 |
| 3.4 | okr.service 注册制（metricType registry + 10 个新查询） | 缺关联层 | ✅ 完成 |

**Gate**：3.1-3.4 全部通过 → S3 管线自举。详见 [knowledge-service.md §12](specs/arch/knowledge-service.md)。

**Post-Gaps**（非阻断，S3 迭代中修复）：OKR 数据源已接线 (B59: 10/13 KR 采集就绪, 2 N/A, 1 近似)、review-orchestrator 共享逻辑提取、文档过期。详见 memory `issue_s3_post_gaps.md`。

### Phase 3.5: 管线优化（手动，~20 行改动）

| 改动 | 文件 | 说明 | 状态 |
|------|------|------|:--:|
| 事件驱动触发 | scheduler-integration.ts | 订阅 goal.stepCompleted → processGoal() | ✅ |
| 事件发射 | event-handler.ts | agent.completed 后 emit goal.stepCompleted | ✅ |
| 轮询间隔 | scheduler-integration.ts | 10s → 30s（安全网） | ✅ |

**管线自举 Q1-Q8 全部已修复**（代码中已有实现，2026-06-06 验证）：

| # | 问题 | 修复位置 |
|---|------|---------|
| Q1 | Reviewer 未触发 → blocked + triage | goal-review.ts:82-95 |
| Q2 | Integration step 竞态 → 创建后 return | goal-lifecycle.ts:141-168 |
| Q3 | worktree 依赖继承 → _baseBranchExecId | goal-crud.ts:389-392 |
| Q4 | 模型 tier 一刀切 → classifyTaskComplexity | scheduler-queue.ts:105-154 |
| Q5 | PipelineRun metrics → parseAgentTokenUsage | scheduler-queue.ts:324-343 |
| Q6 | 数据库路径 → 启动时绝对路径 | index.ts:7-12 |
| Q7 | knowledge.md 剪枝 → selectRelevantSections | analyst-knowledge.ts:56-91 |
| Q8 | auto start → autoStartExecution | analyst-trigger.service.ts:178-181 |

### Phase 3.6: 管线根因修复（2026-06-07）

管线自举暴露的 8 个运行时根因，全部已修复：

| 根因 | 修复 | commit |
|------|------|--------|
| AC 质量差（>5/跨层） | analyst-prompt ≤5 AC + 动词开头 + 单层单组 | 9dec006 |
| Gate 路径验证不足 | requirement-gate tryDirs 扩展 | 9dec006 |
| project.update 异常 | goal-review.ts try-catch 防御 | 9dec006 |
| OKR 目标不合理 | 基于实际数据调整目标值 | 9dec006 |
| OKR DB 不完整 | 7O+23KR 合并入库 | 9dec006 |
| Daemon 重启杀子进程 | systemd KillMode=process | 运维 |
| "Cannot read properties undefined" | prisma 断连（daemon 重启下游） | KillMode 修复 |
| "claude 命令不可用" | 瞬态问题，当前可用 | — |

### Phase 3.7: 管线自举修复（2026-06-08）

6/7 管线自举实际数据：8 Goals，4 成功 (50%)，3 失败，1 阻塞。成功任务均为单 step 小任务，多 step 任务全部失败。

| 根因 | 修复 | commit |
|------|------|--------|
| OpsAgent 误判 idle（不检查子进程） | DB 检查 running GoalExecution | 82788c3 |
| branch `+` 前缀（findTaskBranch） | sed regex 修复 | 82788c3 |
| PIPELINE_API_KEY 未注入 | session-manager 注入 ANTHROPIC_AUTH_TOKEN | 82788c3 |
| Max sessions exhausted | 未修（资源限制） | — |

### Phase 3.8: 管线阻断修复 + harness 升级（2026-06-10）

管线自举暴露 4 个阻断问题 + contractTests 硬校验问题，全部已修复。harness 从 tgz 本地引用迁移到 npm 发布。

| 问题 | 根因 | 修复 | commit |
|------|------|------|--------|
| P1 Worktree ENOENT | 重启后 worktree 目录丢失，running execution 永远挂起 | `validateWorktreePaths()` 启动扫描 | 612c12a |
| P2 Cascade permanent fail | `cascadeBlockedFailures()` 用 `failed` 状态，不可重试 | 改用 `blocked_by_dependency` + `resetBlockedByDependency()` | 612c12a |
| P4 Daemon status 本地引用 | CLI `daemon.isStarted()` 检查本地进程实例，非 API | HTTP endpoint `GET /api/v1/daemon/status` | 612c12a |
| P9 Analyst 重复实现 | 已实现功能仍创建 Goal + contractTests | 铁律：已实现→`skipReason` + 空 acGroups | 612c12a |
| contractTests 硬阻断 | trivial 任务无代码行为可测，card 永远 blocked | `contractTestsSkipReason` 机制 + card status→blocked | 612c12a |
| CLI 轮询僵硬 | 10s 轮询 + 无限重试 | SSE push (`goal.created`) + fallback poll | 612c12a |
| requirement-gate 绝对路径 | `path.join(base, absolutePath)` 拼接错误 | `path.isAbsolute()` 检查 | 612c12a |
| harness tgz 本地引用 | 13 个包用 `file:tgz`，无法版本管理 | 迁移到 `@dommaker/harness@^0.16.0` (npm) | 30c85f9 |
| release 工具缺保护 | 无分支校验/remote 同步/tag 重复检测 | 4 项检查 + 保护分支 PR 流程 | harness d6f1696 |

**harness v0.16.0**：prefer_worktree 从 iron_law 降为 guideline，KnowledgeStore interface 提取，release 工具增强。

### Phase 3.9: 管线可靠性修复（2026-06-10）

管线自举 P5/P6/P6.5 过程中暴露 8 个问题，全部 TDD 修复。

| 问题 | 根因 | 修复 |
|------|------|------|
| Worktree lost | `resolveWorkspace` 返回 VPS 路径，worktree 从未创建 | `hasWorktree=true` 时跳过 Priority 2 |
| LLM 错误重跑 Analyst | 失败恢复无确定性路由 | `classifyFailureAction()` 确定性路由 |
| 矛盾消息 | 格式验证和质量门都叫"质量检查" | 消息去歧义：结构验证 vs RequirementGate |
| Gate 失败从头重跑 | gate 失败后 Analyst 从头来 | `buildRevisionPrompt()` 带反馈修正，最多 2 次 |
| cascade 无 GoalPlan | createGoalFromChannelDoc 不生成 Plan | 从 acGroup.dependencies 重建 steps |
| blocked 不恢复 | 重试成功后 blocked_by_dependency 不自动 reset | `resetUnblockedSteps()` 依赖成功→pending |
| scheduler 不触发 cascade | 只在全 terminal 时调 checkGoalCompletion | 有 failed + pending 时触发 |
| scheduler terminal 不含 blocked | blocked_by_dependency 不在 terminal 中 | 加入 terminalStatuses |

61 新测试。76/76 全绿。

### Phase 3.10: WorkspaceRepo 自动发现（AS-023）

管线 worktree 根因：`getProjectRepoPath()` 返回 `~/projects`（非 git repo）。需要 WorkspaceRepo 表 + 自动发现 + Analyst 仓库识别。

| 步骤 | 内容 | 状态 |
|------|------|------|
| P1-1 | WorkspaceRepo schema + migration | ✅ |
| P1-2 | handleDiscoverRecursive（递归扫描 + remote/branch 提取） | ✅ |
| P1-3 | Registration payload 增加 repos 字段 | ✅ |
| P1-4 | Server 端 upsert WorkspaceRepo | ✅ |
| P2-1 | getProjectRepoPath 改造：先查 WorkspaceRepo | ✅ |
| P2-2 | Analyst prompt 注入可用仓库列表 | ✅ |
| P2-3 | Analyst output schema 增加 targetRepo 字段 | ✅ |
| P2-4 | Goal 创建时绑定 workspaceRepoId | ✅ |
| P3-1 | 跨仓需求拆分 (`splitAcGroupsByRepo`) | ✅ |

详见 [AS-023 spec](specs/AS-023-workspace-repo-discovery/spec.md)。

**下一步**：管线自举验证（用 AS-023 链路跑实际需求）。

### Phase 3.11: 分支逻辑修复（B37）

管线分支管理 7 个问题，18 个测试覆盖。

| Issue | 根因 | 修复 | 文件 |
|-------|------|------|------|
| 1 | baseBranch 硬编码 `'main'` | `getDefaultBranch()` 动态检测 | worktree-resolver.ts |
| 2 | 分支名冲突无所有权检查 | 统一 `task/<executionId>` 命名 | worktree-resolver.ts |
| 3 | 集成合并缺 `--no-ff` | 加 `--no-ff` 保留分支拓扑 | scheduler-prompt.ts |
| 4 | findTaskBranch 模糊匹配歧义 | 由 #2 间接修复（精确匹配） | — |
| 5 | cleanup 误删 daemon/* 分支 | 全分支类型 scope guard | deploy-agent.service.ts |
| 6 | merge queue 无超时死循环 | 5 分钟超时 + force-release | deploy-agent.service.ts |
| 7 | PMO 截断导致分支找不到 | integration 分支用完整 executionId | scheduler-prompt.ts |

18 tests, 32 total (含 worktree-resolver + goal-crud) 全绿。

### Phase 3.12: 管线冒烟修复（2026-06-11）

冒烟测试暴露 6 个阻断问题，全部已修复。

| # | 问题 | 根因 | 修复 | commit |
|---|------|------|------|--------|
| 1 | Token 追踪全为 0 | `parseSessionMetrics` 解析 last-line `modelUsage`，stream-json 格式无此字段 | `extractUsage()` 聚合所有 event.usage + fallback | b417b5e5 |
| 2 | Review crash → approved | `review-agent.service.ts` 5 处 error/fallback 返回 `approved: true` | 全部改为 `approved: false` | b417b5e5 |
| 3 | Review score=0 放行 | 无最低分数门禁 | `MIN_REVIEW_SCORE=50` + `effectiveApproved` 逻辑 | b417b5e5 |
| 4 | Deploy 失败不回滚 goal | goal 在 `checkGoalCompletion` 标记 succeeded，deploy 失败 "non-blocking" | `deploySuccess` 跟踪 + 回滚 goal status | b417b5e5 |
| 5 | PostEval 只报告不修复 | `postEvalAgent.evaluate()` 返回值被丢弃 | completeness < 50% → 回滚 goal + channel 通知 | df0cb4aa |
| 6 | CLI --wait 匹配旧 goal | SSE 回退 polling 用 `executions.recent[0]` 无时间过滤 | `sinceMs` 时间过滤 + 优先匹配 executing goals | 4a1b0831 |
| + | deployVps Docker 流程 | 当前用 systemd+tsx，docker build/push/compose 从未成功 | 移除 deployVps，merge+push 即完成 | 8b6b627e |

冒烟数据（v3）：executor 90s, inputTokens 31K, cacheHitRate 89.7%, model mimo-v2.5-pro。

**关键发现**：管线固定成本（上下文重建 + session 启动 + API 往返）占 76%。管线价值不是速度，是结构化需求 + AC 自动验证 + 知识沉淀。小任务（<1h）不应走管线。

详见 `pipeline-self-bootstrap-analysis-2026-05-24.md`。

**S3 后模式**：所有新需求通过管线执行，不再手动开发。

### Phase 3.13: 管线可靠性批量修复 B45-B47 + 认证修复（2026-06-15）

OKR gap 分析驱动的系统性修复。11 commits，30+ 新测试。

| # | 批次 | 问题 | 根因 | 修复 | commit |
|---|------|------|------|------|--------|
| 1 | B45-1 | Deploy 0% 成功率 | push pre-flight ls-remote 在 retry loop 外 | 移入 loop 内 + merge-failed 事件 | 7c741c65 |
| 2 | B45-2 | PipelineReview 表空 | goal-review 只写 trace，不写 PipelineReview | 补 PipelineReview.create + StudioEvent | e59e6f4f |
| 3 | B45-2 | Reviewer 崩溃静默 pass | 外层 catch approved:true | 改为 approved:false | e59e6f4f |
| 4 | B45-3 | Token 追踪全为 0 | 4 个独立 bug（truthy 'unknown'、parseClaudeUsage 对纯文本、JSON.parse 对 stream-json、extractUsage 缺 model） | 逐个修复 | 7c741c65 |
| 5 | B46-1 | Analyst 无 turn 限制 | 未传 --max-turns | TIER_MAX_TURNS: fast=8/standard=15/premium=25 | a9e32b90 |
| 6 | B46-2 | OKR rollback 查不到数据 | 系统无 rollback 机制 | 返回 0 + N/A 说明 | a1eb8a3d |
| 7 | B46-2 | OKR cost 数据源缺失 | 未读 StudioEvent.costUsd | 优先 costUsd + token fallback | a1eb8a3d |
| 8 | B47-1 | Conservative mode 死代码 | effectiveConcurrency 只用于 log | getAvailableSlots(maxCap) + processGoal 接线 | 8fdba3f2 |
| 9 | B47-2 | not-retryable 写 failed | 不区分 failureClass | mark-blocked → blocked_by_dependency | 8fdba3f2 |
| 10 | fix | **所有管线 spawn 401** | buildSpawnEnv 设 ANTHROPIC_AUTH_TOKEN，CLI 读 ANTHROPIC_API_KEY | 环境变量名修正 | 6b3d635e |
| 11 | fix | config.env export 前缀崩 systemd | systemd EnvironmentFile 不支持 export | 去 export + CLI parser 防御性剥离 | 8157f904 |

**管线验证（23:21）**：Analyst ✅ 65.8s → Executor ✅ 129s → Review 🔴 400（qwen3.7-plus 与 DeepSeek 不兼容，新发现问题）。Worktree deps cache HIT（P0 修复生效）。

### Phase 3.14: 全量问题修复 B48（2026-06-15）

7 个已知问题系统性修复。4 commits。

| # | 问题 | 根因 | 修复 | commit |
|---|------|------|------|--------|
| 1 | Executor deps install 失败 | WorkspaceRepo→studio-config→zombie main→pnpm v6 lockfile | 删 main 分支 + DB defaultBranch→master + package.json 过滤 + lockfile fallback | 2d6866f4, 2eadd324 |
| 2 | 4 个 skill template 测试失败 | 测试路径多一层 trigger 子目录 | 3 文件 8 处路径修正 | 2d6866f4 |
| 3 | 7 个 MonitorAgent CRITICAL | reviewScore=0 误判为低分 | `reviewScore > 0` 过滤 | 2d6866f4 |
| 4 | Execution 卡 125h | autoAbandon 只清 running 不清 pending | 覆盖 pending + 父 goal 终态检查 | 2d6866f4 |
| 5 | KnowledgeBus 80 孤儿进程 | exec shell wrapper 超时不传播 SIGTERM | exec→execFile + 重试无上限 | 2eadd324 |
| 6 | 错误消息为空 | pnpm 写 stdout 不写 stderr | stderr||stdout 聚合 | 2eadd324 |
| 7 | O2-KR1 CST baseline | 不存在 | 标 N/A | e794c452 |

**管线验证**：Analyst→Executor 全链路打通。Reviewer 400 是新发现问题（qwen3.7-plus 与 DeepSeek 不兼容）。

### Phase 3.15: Reviewer 400 修复 B49（2026-06-16）

Reviewer CLI 400 + PipelineReview 多 cycle 冲突。1 commit。

| # | 问题 | 根因 | 修复 | commit |
|---|------|------|------|--------|
| 1 | Reviewer 400 invalid_parameter | `--model "deepseek-v4-flash"` CLI flag 不被 DeepSeek 端点支持；executor 不传 --model flag 则正常 | 4 处 spawn 去掉 --model flag，CLI fallback 默认模型 | 4a70a2e6 |
| 2 | PipelineReview unique constraint | 多 cycle review 重复 create 同一 executionId | create → upsert（goal-review + review-agent） | 4a70a2e6 |

**关键发现**：Claude CLI `--model` flag 与 `ANTHROPIC_MODEL` env var 行为不同。flag 强制使用 → 400；env var 设为无效值 → CLI 忽略 → fallback 默认。对 DeepSeek/proxy 端点不传 --model flag。

### Phase 3.16: AuditorAgent + KnowledgeBus + LanceDB B50（2026-06-16）

3 个基础设施问题修复 + LanceDB 重建。1 commit。

| # | 问题 | 根因 | 修复 | commit |
|---|------|------|------|--------|
| 1 | AuditorAgent logger 丢失 | 动态 import CJS 包 ESM 互操作断裂，命名导出全部丢失 | 改静态 import | c386e578 |
| 2 | KnowledgeBus 155 孤儿进程 2.4GB | 无限 retry + exec shell wrapper | retry cap 10 + 启动 pkill | c386e578 |
| 3 | LanceDB 膨胀 9.6GB | 并发写冲突 → 189K transactions | 删表重建 → 30MB / 445 txn | 手动 |

**当前状态**：管线全链路 Analyst→Executor→Review 打通。KnowledgeBus ingest 正常，MCP 查询可用。18 个根因全部修复。

### Phase 3.17: 管线端到端狗粮验证 B51（2026-06-16）

用真实需求走完全管线，验证 Analyst→Executor→Review→Deploy 闭环。Deploy 首次成功。

| # | 发现 | 根因 | 修复 | commit |
|---|------|------|------|--------|
| 1 | Deploy 4/4 全失败 | getProjectRepoPath Priority 3 选 studio-config（lastSyncedAt DESC 第一），worktree 从错误 repo 创建 | REPO_DIR env 添加为 Priority 3，DB WorkspaceRepo 降为 Priority 4 | fe88e333 |
| 2 | Executor 空实现 | goal 标 succeeded 但无实际文件改动 | 待修复（质量问题） | — |
| 3 | Review cycle 2 误判 | 空 diff 给 score=100 通过（cycle 1 正确拒绝） | 待修复（质量问题） | — |

**验证结果**：管线 9 阶段基础设施全通过。PostEval 完成度检查正确回滚空实现 goal。19 个根因已记录。

### Phase 3.18: Pipeline 并行化 + 质量修复 B52（2026-06-16）

B51 端到端验证暴露 4 个结构性问题 + Analyst 并行 Scout 架构 + 12 监控点。

| # | 修复 | 根因 | 改动 | 测试 |
|---|------|------|------|------|
| 1 | Executor per-execution session | shared-sessions 跨 GoalExecution 复用 → Claude 读 stale .progress.json → 空实现报成功 | 删 shared-sessions/goal-sessions，改用 execution-sessions/<executionId>；新增 token 累积器 | 70/70 (11 new) |
| 2 | Review 空 diff 预检 | 空 diff 送 LLM → Claude 无上下文给 score=100 | 空 diff 直接 reject，不送 LLM | 7/7 (3 new) |
| 3 | 删除 fast tier acGroup 合并 | fast tier 无条件合并所有 acGroups → 并行机制死代码 | 删 L469-488 合并块，acGroups 保留原始拆分；新增 acgroup-tier.ts 纯函数 | 100/100 (8 new) |
| 4 | Analyst 并行 Scout | 单 session 串行探索 → 上下文膨胀 | PreScan(规则) → Scouts×N(并行) → Synthesizer；fast tier 直通路不变 | 128/128 (28 new) |

**监控点（12 个，覆盖 OKR 13 KR）**：

| # | Tag | 服务 KR |
|---|-----|---------|
| 1 | `[AgentRunner] Session resolved` | Fix 1 验证 |
| 2 | `[AgentRunner] Session token summary` | O2-KR2 缓存命中率 |
| 3 | `[ReviewAgent] Diff stats` | O3-KR2 |
| 4 | `[ReviewAgent] Empty diff rejected` | O3-KR2 reject 分类 |
| 5 | `[Channel] Goal splitting` | O4-KR1 并行度 |
| 6 | `[AnalystTrigger] Route decision` | Scout 使用率 |
| 7 | `[AnalystScout] Scouts dispatched` | O1-KR2 |
| 8 | `[AnalystScout] Scout completed` | Scout 质量/成本 |
| 9 | `[AnalystSynth] Synthesis completed` | 合成质量 |
| 10 | `[AnalystTrigger] Phase complete` | O1-KR2 阶段耗时 |
| 11 | `[GoalScheduler] Actual dispatch` | O4-KR1 |
| 12 | `[Pipeline] B52 attribution` | 全部 KR 归因 |

**架构决策**：
1. Pipeline 多进程（非 Claude 内部子 agent）— Executor 写文件必须 worktree 隔离
2. per-execution session — 代价: O2a 缓存失效；收益: 消除 session 污染
3. 删除合并不做条件合并 — 无任意阈值
4. Scout 全部失败 → fallback 到当前单 session 路径（不阻断管线）

**OKR 影响**：O2-KR2 缓存命中率 🔴 可能下降（监控点 2 验证），O3-KR2 Review 通过率 ✅，O4-KR1 并行度 ✅。

### Phase 3.19: ContractTest 质量保障（2026-06-16）

B51 狗粮暴露 contractTest 质量问题：goalexecution-failuretype 11 ACs 仅 3 个有测试 (27% 覆盖)，测试从未执行。方案 A+C：确定性 4 层验证 + Revision 闭环。

| # | 层 | 检查内容 | 实现 | 测试 |
|---|---|---------|------|------|
| 1 | AC Coverage | 每个 acGroup 的 contractTests 覆盖 >=60% ACs | 启发式：test块数/AC关键词/acGroupId 提及 | contract-test-validator.test.ts (25) |
| 2 | TypeScript Syntax | ts.transpileModule + AST 遍历 test/it 缺 callback | contract-test-validator.ts | 同上 |
| 3 | Import Path | 解析相对路径 + 扩展名尝试 (.ts/.tsx/.js/.jsx) | contract-test-validator.ts | 同上 |
| 4 | RED Verification | vitest 执行确认测试失败（RED 状态） | contract-test-red-check.ts | contract-test-red-check.test.ts (9) |

**Revision 闭环**：Layer 1-3 失败 → buildRevisionPrompt → Analyst 修正 → 最多 2 轮 → 超限放行+警告。

**5 监控点（CT-1~CT-5）**：

| # | Tag | 内容 |
|---|-----|------|
| CT-1 | `[ContractTest] Validation` | 每层结果（per acGroup/file） |
| CT-2 | `[ContractTest] AC Coverage` | 汇总（totalAcs/covered/rate） |
| CT-3 | `[ContractTest] RED Verification` | vitest 结果（exitCode/failureType/durationMs） |
| CT-4 | `[ContractTest] Revision` | 循环（round/triggerLayer/gateIssues） |
| CT-5 | `[ContractTest] Final Quality` | 总结（coverage/revisionRounds/allPassed） |

**架构决策**：
1. 纯函数优先 — Layer 1-3 无副作用，易测试
2. RED 验证用 vitest — 与 Executor 一致
3. Revision 复用 buildRevisionPrompt — 无新 prompt 工程
4. 2 轮上限 — 避免无限循环，超限放行+监控

**Commit**: `a15515d6` — 5 files, +1619 lines, 34 tests all green

### Phase 3.20: B51 狗粮需求补完 — goalexecution-failuretype 11/11 AC（2026-06-16）

B51 狗粮需求 goalexecution-failuretype 原 5.5/11 AC (50%)，现全补齐。

| # | AC | 改动 |
|---|---|------|
| B.1 | handleGoalFailed 持久化 failureType | classifyFailureAction fallback 时 update GoalExecution.failureType |
| B.2 | handleGoalFailed 读 failureType 路由 | 优先 persisted failureType，fallback classifyFailureAction |
| B.3 | select 添加 failureType | findFirst select 加 failureType: true |
| B.4 | handleGoalFailed 路由测试 | 6 测试覆盖所有 failureType 路由分支 |
| C.2 | routes.ts 传递 failureType | GET /api/v1/goals?failureType=X |
| C.3 | goal.service.ts 传递 failureType | listGoals 签名加 failureType |

**Commit**: `61f347f2` — 6 files, +292 lines, 9 tests. requirement status: confirmed → implemented

### Phase 3.21: B54 architectureContext 质量闭环（2026-06-16）

管线自举阻塞在 RequirementGate，根因分析发现两个问题：

**问题 1**: analyst-prompt.ts 指令矛盾 — L52 对 Simple tier 说"精简 architectureContext"，L165 说"所有 tier 一致"。模型遵循 L52，导致 fast tier 产出的 architectureContext 稀疏，Executor（fast 模型）无法定位改动位置。

**问题 2**: requirement-gate.ts Stage 2 检查层错误 — prompt 不传 architectureContext 给 LLM，却在 AC 文本里检查文件路径/行号。AC 文本是行为层（what），architectureContext 是实现层（how）。检查错了层导致 100% 失败，降级为 warning 是 band-aid。

修复：
1. analyst-prompt.ts: 删除 tier 分级对 architectureContext 精度的影响，统一为完整填充（functions+行号+callChain+imports+typesInScope+testMock+dangerZones+verifiedAt）
2. requirement-gate.ts: Stage 2 prompt 传入 architectureContext，Check #5 "AC 五要素"→ Check #4 "architectureContext 完整性"，新增 `arch-ctx-incomplete` hard gate，移除旧 `ac-missing-elements` band-aid
3. AcGroup interface 新增 architectureContext 可选字段

### Phase 3.22: B55 管线 Session 隔离 + Analyst 健壮性 + SDD 清理（2026-06-16）

管线自举过程中发现的可靠性和隔离问题修复：

**Session 隔离**：
- agent-runner.ts / session-manager.ts: HOME=/tmp/pipeline-${executionId} 隔离，防止用户 ~/.claude/settings.json 覆盖管线配置（DeepSeek API keys/models）
- agent-runner.ts: `tier: model` → `tier: taskTier`（model 是模型名不是 tier，buildSpawnEnv 需要 tier）
- review-agent.service.ts: 同上 HOME 隔离 + reviewer 强制 tier: 'standard'

**Analyst 健壮性**：
- analyst-trigger.service.ts: Synthesizer/Analyst/Revision 全部强制 premium（不用 preTier 漂移）
- 3 处空输出守卫（outputLen=0 → retry once）
- Revision 空结果保护（不覆盖已有 response）
- SDD markdown 格式改进（AC 改 checkbox 格式，结构化 section）

**ContractTest**：
- contract-test-validator.ts: P1-1 forward reference 检测（parent dir exists = 文件将由 Executor 创建，不算 broken import）

**SDD 清理**：
- 删除 12 个 attempt SDD 目录（apps/api/docs/sdd/，错误路径）
- 删除 6 个无实现的 timeout 测试文件
- *.tsbuildinfo 加入 .gitignore

### 管线自举狗粮计划

用管线开发管线，每步产出可度量的改进。两个 OKR（管线效率 + 知识飞轮）持续驱动。

```
P3 (Platform)                ← 管线自举入口
  ↓ 用管线执行 P4
P4 (Decision Capture)        ← 最低耦合，验证管线可用
  ↓ 用管线执行 P4.5
P4.5 (AS-021 核心)           ← 执行层统一 + 数据采集 + Workspace
  ↓ 数据管道通，开始监控 OKR
P6.5 (Skill 统一)            ← 消费统一数据，Skill .md 全切
  ↓ Skill 改进，管线质量提升
P8 (反馈+蒸馏)               ← 利用数据管道做蒸馏
  ↓ 飞轮转起来
P9 (Daemon 统一)              ← Daemon→AgentRunner + 外部接入 + 编排Agent(待确认)
  ↓
P10+ (进化闭环)              ← 持续优化
```

**狗粮循环**：每个 Phase 用管线执行 → 采集数据 → 驱动 OKR → 指导下一 Phase。

**当前状态**：管线全链路打通（Analyst→Executor→Review）。KnowledgeBus ingest 正常。18 根因全部修复。下一步：管线自举狗粮计划 P4 (Decision Capture)。

**管线优化（2026-06-12）**：
- 失败上下文持久化：`ExecutionResult.failureLog` 存入 `GoalExecution.output`
- 任务去重：同标题 Goal 24h 内失败过 → 拒绝提交
- Integration 轻量化：增量 tsc（--incremental）+ 影响范围测试（只跑变更文件对应的测试）
- Review 职责分离：Review 只做 LLM 审查，不跑测试不写代码

**P6.5 完成（2026-06-14）**：
- 第一性设计：SKILL.md = 纯内容（frontmatter + prompt body），无 trigger 配置
- 移除 `SkillTrigger` 类型 + `trigger` 字段 + `intentKeywords` 字段（types/loader/consumers/tests 共 26 文件）
- flat 结构统一：`~/.studio/skills/<name>/SKILL.md`，5 条读写路径归一
- intent-router 改为 name/description 子串匹配（纯函数，7 测试）
- boundSkills 注入：scheduler-dispatch 读取 roleConfig.boundSkills → loadSkill → 追加 prompt
- MCP SSE + 元数据索引：executor 通过 MCP loadSkill 按需获取完整 skill 内容
- 53 测试全绿（intent-router 7 + loader 16 + skill-index 6 + skill-md-gen 3 + role-skill-binding 3 + skill-loader 18）

**P9 Daemon 统一（2026-06-15）**：
- 第一性验证：P9 原 scope 3 项中仅 MCP loadSkill 已完成，YAML 角色配置被 DB RoleConfig 替代（设计决策），Daemon 未统一到 AgentRunner
- AgentRunner 新增 `executeLightweight()` — 保留核心能力（worktree/harness/stream-json/events/metrics），跳过重型步骤（SDD/REQUIREMENTS/Iron Laws/stuck detection/多 session）
- SessionManager.runTask() 委托给 agentRunner.executeLightweight() — 清理 6 个直接 import，session 管理保留在 SessionManager
- 18 测试全绿（session-manager 18，含 7 个 P9 delegation 测试）

**P9 外部算力接入（待讨论，方案不明确）**：
- 目标：Studio 从"执行者"变为"调度者" — 外部算力节点连接 Studio，注册 agent，Studio 分发任务，算力方付 token
- 当前状态：所有 Agent 是 Studio 同机 spawn 的 Claude CLI 子进程（Studio 管 API key + 付 token）
- 需讨论：
  - [ ] 算力节点注册协议（怎么连上 Studio）
  - [ ] Agent 能力发现（自动扫算力上的 agent，识别能力）
  - [ ] 任务分发模型（Studio 推任务 vs 算力拉任务）
  - [ ] 结果回收（外部 agent 完成后回报结果的协议）
  - [ ] Skill 如何映射到不同 agent（Claude Code / Cursor / 自定义 CLI）
  - [ ] 费用模型（算力方承担 token，Studio 只做调度）
- 参考：spec `docs/specs/arch/external-agent-runtime.md`（Skill 格式已设计，运行时接入未设计）

**P9 编排 Agent 替代硬编码调度（待确认需求）**：
- 来源：多 agent 并行开发日志对比分析（2026-06-15）
- 目标：用"有脑编排者 + 轻量执行者"替代当前 GoalScheduler 的硬编码 DAG 调度
- 当前状态：GoalScheduler 是纯代码逻辑（`getExecutableSteps()` + `Promise.allSettled`），step 之间不共享上下文，不能动态调整计划
- 借鉴模式：Claude Code 多 agent 编排 — 编排者 spawn Explore/Implement agent，读结果后动态决策，step 间传递中间上下文
- 待确认：
  - [ ] 编排 Agent 的运行模式（interactive vs `--print` + tool use）
  - [ ] step 间中间结果传递机制（共享文件 vs 消息总线 vs agent-to-agent）
  - [ ] 与现有 GoalScheduler 的兼容策略（渐进替换 vs 并行运行）
  - [ ] Explore 阶段是否独立于 Analyst（调研与分解解耦）
  - [ ] 目录级冲突分区是否替代文件列表标注
- 关联优化（不依赖 P9，可独立做）：
  - Analyst 标注 `targetDir` 替代 `files[]`（目录级冲突检测）
  - Monitor Agent 展示 DAG 进度视图

### Phase 4-14: 管线驱动开发

管线自动执行，外部 Agent 运行时同时可用（共享 PipelineService）。**S3 后所有需求走管线。**

| Phase | 模块 | 内容 | 依赖 | 状态 |
|-------|------|------|------|------|
| P4 | Module 2 | Decision Capture | P3 | ✅ 完成 |
| **P4.5** | **AS-021** | **执行层统一 + 数据采集 + Workspace（[spec](specs/AS-021-skill-unified-architecture.md)）** | **P4** | ✅ 完成 |
| P5 | Module 1 | Self-Document | P3 | ✅ 完成 |
| P6 | Module 3 | Workflow Skills (/req + /impl + /review) | P4 | ✅ 完成 |
| P6.5 | Module 11 | Skill 统一 + pipeline-utils（共享能力层） | P4.5 | ✅ 完成（trigger 移除 + flat 结构 + intent-router + boundSkills 注入 + MCP SSE） |
| **P6.6** | **SP-004** | **SDD 知识架构：Requirement→Design→Task 三层拆分 + 版本管理 + Doc Freshness + grep 知识图谱（[spec](specs/design/SP-004-sdd-knowledge-architecture.md)）** | **P6.5** | **✅ 完成（40 requirement + 34 design + 22 task，三层独立文件，SDD-only 消费，分层 Doc Freshness）** |
| P7 | Module 8 | Scheduler + 基础设施 | P5 | 待开始 |
| P8 | Module 10 | 补缺口 — Feedback + Extract + 蒸馏 + Evolver 接线 | P6.5 | 待开始 |
| P9 | Module 10 | Daemon 统一 AgentRunner + 外部算力接入 + 编排 Agent | P4.5 | 进行中（Daemon→AgentRunner lightweight 完成，外部算力接入待讨论，编排 Agent 待确认） |
| P10 | Module 5 | Evolution Close-Loop | P8 | 待开始 |
| P11 | Module 4 | Constraint Lifecycle | P10 | 待开始 |
| P12 | Module 6 | Self-Improvement | P4+P6 | 待开始 |
| P13 | Module 7 | Quality Improve | P10 | 待开始 |
| P14 | — | 后评估统一 | P13 | 待开始 |

**验收**：[verification.md](specs/arch/verification.md) 五层验收（模块 AC + 知识飞轮 OKR + AC 追踪 + E2E 场景 + 管线 OKR）

---

## OKR

两个激活 OKR，23 个原子 KR：

| OKR | O | KR | 文档 |
|-----|---|-----|------|
| 知识飞轮质量 | 3（质量/效用/进化） | 10 | [knowledge-okr.md](OKR/knowledge-okr.md) |
| 管线效率与质量 | 4（时间/经济/质量/并行） | 13 | [pipeline-okr.md](OKR/pipeline-okr.md) |

监控覆盖度：[monitoring-matrix.md](OKR/monitoring-matrix.md)（7✅ 6⚠️ 10🔴）

---

## 核心指标

飞轮价值 = 知识质量 × 消费命中率 × 执行改善度 → [Knowledge OKR v3](OKR/knowledge-okr.md)
管线价值 = 时间效率 × 经济效率 × 质量效率 × 并行效率 → [Pipeline OKR v3](OKR/pipeline-okr.md)

---

## 设计文档索引

> 完整索引：[INDEX.md](INDEX.md)（specs + sdd + 顶层文档，DOC-IMPACT 检查入口）

| 文档 | 内容 |
|------|------|
| [arch/index.md](specs/arch/index.md) | **全局架构** — Vision + System Model + 子文档索引 |
| [arch/constraints.md](specs/arch/constraints.md) | 约束生命周期 |
| [arch/flywheel.md](specs/arch/flywheel.md) | 知识飞轮 6 阶段 + 原语 + 类型 |
| [arch/knowledge-service.md](specs/arch/knowledge-service.md) | KnowledgeService 统一能力层 + 反馈层 + S3 前置验证 |
| [arch/external-agent-runtime.md](specs/arch/external-agent-runtime.md) | 外部 Agent 运行时 + Skill + Agent Loop |
| [arch/documentation.md](specs/arch/documentation.md) | 三层文档 + SelfDoc |
| [arch/workflow.md](specs/arch/workflow.md) | /req + /impl + /review + 管线衔接 |
| [arch/modules.md](specs/arch/modules.md) | 模块分解 + 实现顺序 |
| [arch/platform.md](specs/arch/platform.md) | Studio UI 平台 + HTTP API + SSE |
| [arch/verification.md](specs/arch/verification.md) | 五层验收标准 |

---

## 已完成批次归档

| Batch | 日期 | 内容 |
|-------|------|------|
| B0 | 05-07 | 基础设置：Prisma/Redis→SSE/CLI/Lurk Wall |
| B1-B3 | 05-09~10 | Agent 管线 + 知识引擎初版 |
| B4 | 05-14 | 全量待办清理（S1-S4/trace/IMPL/质量闭环/瘦身） |
| B5 | 05-22 | 管线闭环修复（6 Critical + PMO + 拓扑解耦） |
| B6 | 05-22 | 知识缺口审计（源头捕获+冷启动+新鲜度） |
| B6.5 | 05-22 | 知识进化闭环（质量闸+引用追踪+成熟度） |
| B7 | 05-23 | KE E2E 修复 + Agent 拓扑解耦 + RKB Phase 1 |
| B8 | 05-24 | 管线自举（6 gap + 5 性能 + 3 阶段路由 + 自优化飞轮） |
| B9 | 05-29 | KE 架构修正 + 知识→Skill 闭环 |
| B10 | 05-29 | 用户行为蒸馏 Phase 1 |
| B11 | 05-29 | 知识消费改革（MCP 按需检索 + Resolution 扩展） |
| B12 | 05-30 | 飞轮噪音治理 + 资源优化 + LLM 维护 |
| B13 | 05-30 | 飞轮闭环修复（消费→反馈→进化） |
| B14 | 05-31 | 飞轮架构修复（27/27 断点闭合） |
| B15 | 06-01 | 统一配置管理（config.env + getProviderApiKey） |
| B16 | 06-01 | 知识同步管道修复 |
| B17 | 06-01 | AS-020 全 Phase |
| B18 | 06-02 | 管线 TDD 三阶段 + Prisma shadow DB |
| B19 | 06-02 | AS-018 OKR 闭环 + tsc 清零 + Redis 清理 |
| B20 | 06-02 | AS-019 KE 搜索 + PF 缓存 + Phase 7 验证 |
| B21 | 06-02 | AS-020 P7/P8 UI 集成 + modelTier 统一 |
| B22 | 06-02 | pipeline-simplify + 4 spec 完成 |
| B23 | 06-04 | AS-021 知识类型分类 |
| B24 | 06-04 | AS-022 Phase 1+2 统一注入 + UnifiedQuery |
| B25 | 06-04 | AS-022 Phase 3 清理旧路径 |
| B26 | 06-04 | AS-022 Phase 4+5 统一 API + UI |
| B27 | 06-04 | AS-022 双重注入修复 |
| B28 | 06-07 | 管线根因修复（8 项）+ OKR v3 重构 + KillMode |
| B29 | 06-08 | 管线自举经验：OpsAgent 误判 idle 修复 + findTaskBranch + PIPELINE_API_KEY + 部署 |
| B30 | 06-08 | 管线狗粮：FailureEvent 分类+路由基建（schema + classifyFailure + routeFailure + dispatch 集成） |
| B31 | 06-08 | 管线优化：tier 倒灌 Analyst（fast→1 step）+ integration 无 Claude 回退 + 5min 超时 + 分支查找修复 |
| B32 | 06-08 | 管线数据+治理：token 采集修复（modelUsage 多模型求和）+ tier 指令修正（统一上下文深度）+ Goal 去重 + worktree 生命周期清理 |
| B33 | 06-09 | 测试健康度大修（29→1 failed files, 53→1 failed tests）+ 硬编码凭证移除 + Admin 密码重置 + test-health-report CLI + /test-fix skill + 架构文档 Skill 统一修正 + OAuth 认证系统 + 陈旧引用清理 |
| B34 | 06-09 | 行为蒸馏产出路径修正（KnowledgeBus → 文件系统）+ PatternMiner 启动即跑 |
| B35 | 06-10 | LLM 架构债务重构（R1-R4）+ 管线生命周期修复（D1-D7）+ Failure Handling System（cascade+retry+classifier）+ P4.5 验证完成 + S3 post-gaps 全部修复: R1 KnowledgeAgent 统一路径→gateway, R2 死代码清理, R3 Gateway per-tier model, R4 CLI spawn 封装(buildSpawnEnv), D1 daemon stream-json 迁移, D2 stream-json 解析器+tool:call 事件, D3 shared resolveWorkspace, D4 AgentExecutor stream-json 迁移(parseStreamEvents+tool:call/file:change 事件), D5 Analyst tier 传播, D6 Analyst 产物事实验证层, D7 Reviewer context 注入(acGroupContext). Failure handling: checkGoalCompletion cascade(201f84c), retryCount+MAX_RETRIES(beb9cd2), failure classifier+retry integration(261b0f7). P4.5 Steps 1-5 全部验证通过. S3 post-gaps: 5 OKR metrics 接线(rollback_rate/quality_gate/skill_created/skill_used/entry_created) + knowledge-service.md 文档更新(8/8 断点已修复). |
| B36 | 06-10 | 管线可靠性修复: worktree lost 根因(hasWorktree 跳过 VPS Priority 2) + 确定性失败路由(classifyFailureAction: infrastructure→retry) + 消息去歧义(结构验证 vs RequirementGate) + Gate 反馈修正(buildRevisionPrompt, 最多 2 次) + cascade 无 GoalPlan(从 acGroup.dependencies 重建) + unblocked reset(依赖成功后 blocked_by_dependency→pending) + scheduler terminal status 含 blocked_by_dependency + scheduler cascade 触发. 61 新测试, 76/76 全绿. |
| B37 | 06-11 | Review 管线修复: diff scope 分类(blocking vs discoveredIssues) + discoveredIssues→KnowledgeStore+Channel 曝光 + Signal Aggregator(原始 signal→趋势聚合 ≥3次/7天) + PostEval 触发 + prompt-builder 优先趋势注入 + rule-scanner PROJECT_ROOT 修复 + 9 测试 |
| B38 | 06-11 | 错误日志修复: 2>&1 导致 stderr 为空→6 处 catch 块丢失错误信息(session-manager/agent-runner/task-executor/scheduler-prompt/scheduler-integration/tools/monitor-agent) + GAP-7 元数据驱动注入(context/signal 层 agentType 过滤) |
| B39 | 06-11 | harness 集成修复: A5 checkConstraint 空 operation 验证 + S13 routes 18 处 lazy import→loadHarness() 类型化 + C2 确认已修复 |
| B40 | 06-11 | 存储统一+文档防腐烂: D-001~D-006 stable(Prisma 3 模型删除: Skill/SkillProposal/KnowledgeEntry) + doc-freshness Skill+CI+Auditor 全链路 + 1021 低密度文件清理 + session:summary 事件修复(daemon 5 处) + TaskExecutor 共享 parseStreamLine + AS-024 Phase 2/3/6 确认已实现 + decisions.md 决策注册表 |
| B41 | 06-11 | P5 Self-Document: harness extractCodeStructure(TS Compiler API) + studio runArchDocs(7 模块架构文档生成) + ImproverScheduler 集成(CONTEXT.md + docs/architecture/*.md hourly) |
| B42 | 06-12 | 管线性能优化 9 项：#1 allComplete 检查跳过冗余 session、#2 fast-tier analyst 跳过 DB knowledge、#3 worktree CLAUDE.md 复制触发去重、#4 git commit 指令、#5 MCP 持久化 bridge(systemd+supergateway)、#6 executor fast-tier 跳过全量 DB knowledge、#7 worktree 依赖缓存(hardlink)、#8 review error issues 强制 rejected、#9 analyst token tracking |
| B43 | 06-12 | 管线优化 4 项 + P6.5 intent-router：失败上下文持久化(failureLog→GoalExecution.output) + 任务去重(24h 同标题拒绝) + Integration 轻量化(增量 tsc+影响范围测试) + Review 职责分离(只做 LLM 审查). P6.5 intent-router: matchIntent()纯函数 + intentKeywords 字段 + 7 测试. 管线自举发现: npm install 耗时>10min→session 超时→需 pnpm install |
| B44 | 06-15 | Docs 基础设施 + 隐私清理：docs/INDEX.md 全量文档索引（specs+sdd+顶层，DOC-IMPACT 入口）+ AS-021/SP-004 CHANGELOG（specs 设计决策变更追踪）+ phase workflow 升级（DOC-IMPACT 环节 + Spec CHANGELOG 规则，8 步循环）+ P9 scope 更新（YAML→DB RoleConfig 设计决策，Daemon→AgentRunner 完成）+ 隐私清理（dommaker.cn→studio.example.com, qunar→company-project, 一人公司→AI Agent, 公司电脑→远程 Workspace, 私有仓库→配置仓库，~120 处替换，20 文件） |
| B52 | 06-16 | Pipeline 并行化 + 质量修复 + ContractTest 质量保障：Executor per-execution session 隔离 + Review 空 diff 预检 + 删除 fast tier acGroup 合并 + Analyst 并行 Scout(PreScan→Scouts→Synthesizer) + 12 监控点 + ContractTest 4层验证(AC Coverage/TS Syntax/Import Path/RED Verification) + Revision 闭环(max 2 rounds) + 5 CT 监控点(CT-1~CT-5). 3 commits: e8dd9df7(305 tests), 732e6396(111 tests), a15515d6(34 tests) |
| B53 | 06-16 | B51 狗粮需求补完：goalexecution-failuretype 5.5/11→11/11 AC. handleGoalFailed 读 failureType 路由(B.2/B.3) + 持久化 fallback(B.1) + 6 路由测试(B.4) + routes.ts/service.ts 传递 failureType(C.2/C.3). requirement confirmed→implemented. commit 61f347f2 (9 tests) |
| B54 | 06-16 | architectureContext 质量闭环：analyst-prompt 删除 tier 分级精度指令(统一完整填充) + requirement-gate Stage 2 传入 architectureContext + Check#5→Check#4(完整性替代AC文本五要素) + arch-ctx-incomplete hard gate + AcGroup 接口扩展 |
| B55 | 06-16 | 管线 Session 隔离 + Analyst 健壮性：HOME 隔离(session-manager/agent-runner/review-agent) + tier: model→taskTier bug fix + Analyst 强制 premium + 3 处空输出重试守卫 + SDD markdown 格式改进 + ContractTest forward reference + SDD attempt 清理(12目录) + 死测试清理(6文件) + tsbuildinfo gitignore |
| B56 | 06-17 | 管线输出韧性 + DB 去重 + 文档新鲜度自治 + 知识死链路清理：session-manager worktree fallback + analyst-executor 绝对路径+rawOutput + analyst-trigger DB dedup(24h+质量门) + JSON sanitize 4层解析链 + requirement-gate Stage 2 确定性化 + 管线监控(phase stall+cancel kill+auto-fail) + ImproverScheduler.refreshStaleContext + 删 knowledge.md 死链路(loadKnowledge/saveKnowledge/selectRelevantSections/formatIndexSummary,零调用方) + analyst prompt/scout 指向 KnowledgeStore. 根因:75%文件丢失+35x重复分析+stale CONTEXT堆积+62KB死文件 |
| B57 | 06-17 | 管线超时自动取消机制（7/7 P 全部完成）：P0 Executor fast-only(e2e2a08a) + P7 统一 alarm 抽象(8d0f570b) + P4 删除 Path A review(05685d0c) + P3 Daemon session 超时 bug(5dbe148d) + P1+P2 timeoutAt+getTimeoutForPhase(224312de) + P5 AC 粒度质量门(68a98de9) + P6 HealthMonitor 30min(abdc4632). 21 新测试，goals 23 files/210 tests 全绿 |
| B61 | 06-30→07-01 | 知识消费管道最后一公里：AgentLoop hint（优先搜 _index.md）+ 知识库索引生成器（`harness knowledge index` CLI）+ knowledge-quality-audit trigger（SCHEDULE cron 3:17 → CREATE WorkUnit）+ audit 4 bug fix + 4 根因修复（P0 parseAcceptedTypes 缺 analysis / P1 systemd PATH 缺 pnpm / P2 skill 指定 .archive/ / P3 trigger API 合并 scheduler+store）+ E2E 验证通过（Agent 自动审计 3 轮，归档 ~180 条噪声，索引 69 条目 0 污染）+ D7 领域相关性维度 + deprecated-domain audit 规则 + index.json 同步修复。harness ec62020+fe53441+5dbe731+12cda1a, studio aefaa18+f053cf9 |
| B62 | 07-01 | 知识库优化第一性分析完成：52 条目溯源 → ~40 写入路径全景 → L1/L2/L3 三层模型 → 8 项决策 → Phase 1 计划定稿（8 任务，SCHEDULE 可行性已验证）。Issue: 2026-07-01-knowledge-base-optimization.md。恢复提示词: prompt_resume_knowledge_optimization.md |
| B63 | 07-01 | 知识库优化 Phase 1 源头修复完成：10 AC 全部实现（AC-A.1~A.5 数据切断 + AC-B.1~B.3 形态门禁 + AC-C.1~C.2 链路改造）。SDD: docs/sdd/kb-optimize-phase1/。7 commits, 33 tests passing, code-review PASS |

---

## 后续开发计划

### Phase 3.23: 管线超时自动取消机制（B57，全部完成 2026-06-17）

**Plan 文件**：[pipeline-timeout-mechanism.md](plans/pipeline-timeout-mechanism.md)

**目标**：消除 60min 兜底超时，实现 per-phase 精确超时控制 + 统一告警通知。

| P | 内容 | commit | 状态 |
|---|---|---|---|
| P0 | Executor fast-only 强制执行 | e2e2a08a | ✅ |
| P7 | 统一 pipeline alarm 抽象 | 8d0f570b | ✅ |
| P4 | 删除 Path A review + 移植副作用 | 05685d0c | ✅ |
| P3 | Daemon session 超时 bug + 动态超时 | 5dbe148d | ✅ |
| P1+P2 | GoalExecution.timeoutAt + getTimeoutForPhase | 224312de | ✅ |
| P5 | AC 粒度质量门 | 68a98de9 | ✅ |
| P6 | HealthMonitor 60min→30min | abdc4632 | ✅ |

**关键成果**：
- Daemon `SessionConfig.timeoutMs` 死代码修复（analyst 45→30min, reviewer 按复杂度动态 10/15/25min）
- Review 双路径冗余消除（Path A 删除，副作用移植到 Path B）
- GoalExecution.timeoutAt per-phase DB 标记 + checkTimedOutExecutions 30s 扫描
- AC 粒度硬质量门（files.length > 5 拒绝）
- HealthMonitor 60→30min 兜底
- 21 新测试，goals 23 files/210 tests 全绿

### Phase 3.24: Phase Gate 验证 + 局部重跑（B58 ✅）

**目标**：每个管线阶段有明确的输入/输出质量门，失败时只重跑该阶段而非全流程。

**已交付**：
- `integration-rollback.ts` — Integration 失败诊断 + 局部 rollback
  - `parseIntegrationFailureType`: error string → 结构化 failureType (merge_conflict/tsc_error/test_failure/missing_branch/unknown)
  - `mapAffectedFilesToSteps`: affected files → git branch → step indices
  - `rollbackToIntegrationStep`: 主入口 — 定位问题 step → 级联下游 → reset pending → 重调度
- `scheduler-dispatch.ts` — 结构化路由: tsc_error/test_failure → rollback; merge_conflict → Claude fallback; missing_branch → mark failed
- `scheduler-prompt.ts` — `runIntegrationInCode` 返回结构化 `IntegrationResult` (failureType + affectedFiles)
- 20 behavioral tests (AC-1~AC-8) 全绿

**状态**：✅ B58 完成 (2026-06-17)

### Phase 3.25: AC 组拆分 + Executor 并行（B60 P2/P3 修复）

**Spec 文件**：[ac-group-splitting-and-executor-subagents.md](specs/pipeline/ac-group-splitting-and-executor-subagents.md)

**目标**：消除无效 AC（"写测试""跑验证"）+ Executor 组内波次并行。B60 场景从 18min 降至 ~4min。

| Phase | 任务 | 类型 | 状态 |
|-------|------|------|------|
| 1 | `req/SKILL.md` 三层过滤 + 禁止 AC 类型 + 质量门 | Skill | 待开始 |
| 1 | `analyst-prompt.ts` 删除 3 处矛盾规则 | Prompt | 待开始 |
| 1 | `validateAnalystOutput` 拒绝"写测试"/纯验证 AC | 安全网 | 待开始 |
| 1 | `contract-test-writing/SKILL.md` 一致性规则 | Skill | 待开始 |
| 2 | `green-only-tdd/SKILL.md` 重写为 sub-agent 约束 | Skill | 待开始 |
| 2 | 删除 `sub-agent-workflow/SKILL.md` | Skill | 待开始 |
| 2 | 波次分析算法（analyzeWaves） | 安全网 | 待开始 |
| 2 | Parent session spawn sub-agents + Promise.all | 安全网 | 待开始 |
| 2 | Parent 统一 git commit | 安全网 | 待开始 |
| 2 | Integration 空 merge 检查 | 安全网 | 待开始 |

**关键决策**：
- Parent = 系统代码（`no_model_for_deterministic`，波次分析 0 项需要 LLM）
- Sub-agent = Claude session（用 `green-only-tdd/SKILL.md` 指导）
- 拆分判据：三层过滤（文件重叠 → 语义依赖 → 独立性）
- 详见 spec §10.2 第一性分析

### Phase 3.26: 管线 Skill 进化 — 优化 + 反馈闭环

**Spec 文件**：[pipeline-skill-evolution.md](specs/pipeline/pipeline-skill-evolution.md)

**目标**：4 个管线 Skill 额外优化 + 自动反馈闭环。无效 AC 率从 30% 降至 <1%。

| Phase | 任务 | Skill | 状态 |
|-------|------|-------|------|
| 2 | files 字段验证规则 | `req/SKILL.md` | 待开始 |
| 2 | 工具集明确（禁止 Grep/Glob） | `green-only-tdd/SKILL.md` | 待开始 |
| 2 | RED 状态验证说明 | `contract-test-writing/SKILL.md` | 待开始 |
| 2 | architectureContext 过期机制 | `req/SKILL.md` | 待开始 |
| 2 | architectureContext 验证步骤 | `green-only-tdd/SKILL.md` | 待开始 |
| 2 | 失败处理流程 | `green-only-tdd/SKILL.md` | 待开始 |
| 3 | 事件采集（Skill 加载/门禁/失败） | 系统 | 待开始 |
| 3 | 每日聚合 + 阈值检测 | 系统 | 待开始 |
| 3 | Skill 版本管理（CHANGELOG + 版本号） | 系统 | 待开始 |

### Phase 3.27: B60 剩余问题修复 — SSE/CLI 卡住/Review 缩放

**Spec 文件**：[b60-remaining-fixes.md](specs/pipeline/b60-remaining-fixes.md)

**目标**：修复 B60 曝光的 P1/P6/P7（P2-P5 已在 Phase 3.25 覆盖）。

| Phase | 任务 | 文件 | 状态 |
|-------|------|------|------|
| 1 | SSE 路由禁用 compression | `app.ts` / `sse.routes.ts` | 待开始 |
| 1 | CLI 轮询加 MAX_WAIT_MS（30min 硬超时） | `studio-cli.ts` | 待开始 |
| 2 | Stuck pipeline 检测 | `scheduler-integration.ts` | 待开始 |
| 2 | isSimpleChange 修复（totalChanged ≤ 20） | `review-agent.service.ts` | 待开始 |
| 2 | Review fast-path（简单变更跳过完整审查） | `goal-review.ts` | 待开始 |
| 2 | Knowledge inject token cap（3000 tokens） | `knowledge-service.ts` | 待开始 |

---

### Phase 3.28: Skill 架构重构（SP-005）

**Spec 文件**：
- [SP-005-skill-restructure.md](specs/design/SP-005-skill-restructure.md) — Skill 重构
- [agent-network-skill-architecture.md](~/.studio/knowledge/agent-network-skill-architecture.md) — 第一性分析结论

**目标**：从第一性原则重新定义 Skill 本质，从 Pipeline 范式转向 Agent Network 范式。

#### 第一性分析结论（2026-06-23 更新）

**Skill 本质**：
- Skill = name + description + content（三字段）
- Skill 是公共品，不属于任何 Role，任何 Agent 都可加载
- Skill 不设 tags，靠语义匹配发现（name + description 是发现接口）
- 编排知识（通用步骤）可以是 Skill，编排决策（何时用什么）是 Agent 判断力
- 同时编码两者的 Skill 不可行（dev-flow 的根因：把决策硬编码为必须执行的步骤）
- 单一职责（链越长适用场景越窄，可组合性越低）

**Role / Runtime / Agent 三层分离**：
- **Runtime**：执行引擎（Claude Code / Codex / OpenCode），安装在 Computer 上
- **Role**：name + description（身份 + 职责），与 Runtime 解耦
- **Agent**：Runtime Instance 承载 Role，运行时实例
- 创建流程：确认 Computer → 扫 runtime → 选择 runtime → 添加 name+description → Role
- 不同 Role 背后可能是同一个 Runtime

**Skill 加载机制 — 双轨制**：
- **主轨：WorkUnit 驱动**：Agent claim WorkUnit → 读 scope → 语义匹配 Skill → 注入上下文
- **辅轨：预绑定**：AgentProfile.defaultSkills（初始偏好，非硬绑定）
- capabilities = 粗粒度匹配（"我能干什么"），skills = 细粒度执行（"我怎么干"）

**Pipeline → Agent Network 的迁移理由**：
- Pipeline 是 Agent Network 的特例（固定序列 + 中央调度）
- 任务性质需要更多自主性和灵活性（并行、涌现、动态重规划）
- Agent Network 是更通用的范式

**系统本质**：能力管理系统。Knowledge Store 沉淀经验，Skill Store 沉淀方法论。

#### Phase 3.28a: Skill 架构基础（重新规划）

**已确认决策（2026-06-23 续）**：

1. **WorkUnit scope = 自然语言 String**，不改格式。给 Agent 读，Agent 理解自然语言。
2. **Skill 发现 = Agent 读 Skill 清单（MANIFEST.md）→ 自己判断**。不需要 RAG/local-rag/语义检索。Skill 数量 < 50，全量列出即可。
3. **命中率在 Skill 设计端保证**：skill-creator eval 优化 description 边界，确保不同 Skill 职责不重叠。
4. **grep 优先于 RAG/MCP**：Skill 发现读清单（零成本），知识检索用 grep 关键词搜索优先，local-rag 兜底。
5. **单一职责新定义**："一个 Skill 回答一个问题"。操作共享同一套底层知识 → 不拆（doc-manager）。不同 mental model → 拆开（tdd-red vs tdd-green）。
6. **Role = name + description**，不设 defaultSkills。Agent 是自主主体，自选 Skill。

**原子 Skill 清单（12 个）**：

| # | Skill | 回答的问题 | 状态 |
|---|-------|-----------|------|
| 1 | session-analyst | "如何分析需求产出 SDD？" | ✅ 已创建 |
| 2 | tdd-red | "如何设计测试契约？" | ✅ 已创建 |
| 3 | tdd-green | "如何最小实现？" | ✅ 已创建 |
| 4 | code-review | "这段代码质量如何？" | ✅ 已创建 |
| 5 | test-diagnosis | "如何诊断测试失败的根因？" | ✅ 已创建 |
| 6 | sdd-reviewer | "这个设计质量如何？" | ✅ 已有 |
| 7 | arch-reviewer | "概念完整性如何？" | ✅ 已有 |
| 8 | spec-reviewer | "这个 spec 可执行吗？" | ✅ 已有 |
| 9 | knowledge-extract | "如何从事件提取知识？" | ✅ 已有 |
| 10 | knowledge-synthesis | "如何跨时间窗口综合模式？" | ✅ 已有 |
| 11 | knowledge-quality | "知识库健康度如何？" | ✅ 已有 |
| 12 | doc-manager | "如何管理结构化文档？" | ✅ 已有 |

**废弃项**：
- tdd-review → 不是 Skill，是 Workflow 步骤（验证是 Agent 自然行为）
- monitor → 不是 Skill，是系统代码（Scheduler 基础设施）+ CLI（harness knowledge health）
- branch-integrator → 不是 Skill，是代码操作（git merge）+ Agent 判断（冲突解决）
- skill-creator → Claude Code 官方 skill，不在我们的清单

**Monitor 职责覆盖映射**：

| 原职责 | Agent Network 接手方 |
|--------|-------------------|
| 超时检测 | Scheduler 基础设施 |
| 孤儿恢复 | Scheduler 基础设施 |
| GC | Scheduler + 系统代码 |
| WorkUnit 状态监控 | WorkUnit 状态机 + Channel 可见 |
| 知识引擎健康 | `harness knowledge health` CLI |
| 指标采集 | 可观测性层 |
| 主动异常检测 | Trigger Registry → analysis WorkUnit → Agent claim |

**下一步**：
- ✅ 创建 session-analyst / tdd-red / tdd-green / code-review（4 个新 Skill）→ 3.28b 完成
- ✅ 用 skill-creator eval 优化每个 Skill 的 description 边界 → 3.28b 完成
- 端到端验证：Agent claim WorkUnit → 读 Skill 清单 → 选到正确 Skill → 3.28c

#### Phase 3.28b: Pipeline 侧审计（✅ 完成 2026-06-23）

| 任务 | 说明 | 状态 |
|------|------|------|
| 审计 40+ Skills | B71 第一性分析：A 类 Pipeline 废弃 6 + B 类降级 2 + C 类合并 10 + D 类保留 7 + E 类降级 3 + F 类 Claude Code 专属 3 | ✅ 完成 |
| 创建 4 个原子 Skill | session-analyst / tdd-red / tdd-green / code-review，方法论从旧 Skill 提取 | ✅ 完成 |
| 精简 Skill frontmatter | 4 个新 Skill 只有 name + description，旧 Skill 已删除 | ✅ 完成 |
| Description eval | 4 个 Skill 各 20 查询，3 轮迭代，原始 description 最优（4/5/4/4 分）| ✅ 完成 |
| 清理已删除 Skills | 16+ 个 Skill 目录删除（含 Pipeline 专属、降级为约束/CLI、方法论已提取）| ✅ 完成 |
| Skill 定义流程固化 | rules 铁律 + standalone 流程文件，确保所有 Skill 创建过 5 步流程 | ✅ 完成 |

**最终 Skill 清单**：14 个目录（4 原子 + 7 D 类保留 + 3 E 类降级参考）

**关键发现**：
- 27→14，48% 精简率
- 有效 Skill 类型：具体工件审查 + 周期任务（Loop-trigger）
- 无效 Skill 类型：设计讨论（抽象对话）、隐式行为
- 知识管理类在 User-trigger 下 0% recall，Loop-trigger 可行

#### Phase 3.28c: Agent Network 演进（⚠️ 95% 2026-06-24 审计）

**Spec 文件**：[agent-network.md](specs/arch/agent-network.md) — WorkUnit 统一模型 + Claim 协调 + 迁移路径

**前置条件**：✅ 3.28a/b 完成（11 原子 Skill 就绪 + Skill 定义流程固化）

**审计结果**（2026-06-24）：数据层/身份/协作/Trigger 全部确认。Skill Discovery 已重构（description 三策略匹配）。端到端未实际跑通。

---

##### 3.28c-1: 数据层基础（✅ 完成）

**目标**：WorkUnit/Claim 数据模型落地

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| WorkUnit Prisma 模型 | type/scope/assigneeId/status/channelId/parentId/dependsOn | 模型创建，migration 通过 |
| Claim 机制 | 乐观锁（UPDATE SET assigneeId WHERE NULL）| 并发测试：2 Agent 同时 claim → 1 成功 1 失败 |
| 状态机验证 | unassigned → active → in_review → done/closed/blocked | 状态流转测试通过 |
| Goal → WorkUnit 迁移方案 | 有损压缩 vs 并行共存 vs 渐进迁移 | 迁移方案文档化 + 用户确认 |

**断点**：Goal/GoalExecution 现有字段如何映射到 WorkUnit；parentId/dependsOn 层级查询性能

---

##### 3.28c-4: Trigger Registry 原型（✅ 完成）

**目标**：最小 Trigger 机制（SCHEDULE + CREATE）

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| Trigger 数据模型 | id/name/condition/action/enabled/scope | YAML 文件存储（`~/.studio/triggers/*.yaml`），非 Prisma（设计选择） |
| SCHEDULE condition | cron 表达式解析 + 调度 | cron 触发测试通过 |
| CREATE action | 创建 WorkUnit（type/scope/channelId）| Trigger 触发后 WorkUnit 自动创建 |
| Trigger 调度器 | 定时检查 → 触发 action | 调度器运行日志可查 |

**审计确认**（2026-06-24）：trigger-store.ts（YAML CRUD）+ trigger-scheduler.ts（内存状态）+ trigger-action.ts + trigger.routes.ts + 5 测试文件。存储迁移条件见设计决策 #3。

**依赖**：3.28c-1（WorkUnit 模型）
**并行机会**：可与 3.28c-2 并行

---

##### 3.28c-2: Agent 身份化（✅ 完成）

**目标**：Role = name + description 极简模型

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| 验证现有 Role 模型 | 字段是否符合 name + description | 模型审计完成 |
| AgentProfile 调整 | channels[] 字段（订阅 Channel）| channels 字段可用 |
| 移除 defaultSkills | Agent 自选 Skill，不预绑定 | Agent 创建时无 defaultSkills |

**依赖**：3.28c-1
**并行机会**：可与 3.28c-4 并行

---

##### 3.28c-3: Channel 协作化（✅ 完成）

**目标**：Channel = 工作路由器，WorkUnit 可见

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| WorkUnit → Channel 关联 | channelId 字段，查询 Channel 内 WorkUnit | API 查询 Channel 内 WorkUnit 列表 |
| Channel 消息关联 | ChannelMessage.workUnitId（讨论空间）| 查询 WorkUnit 的讨论空间 |
| WorkUnit 状态推送 | 状态变化 → Channel 通知 | 状态变化后 Channel 可见 |

**依赖**：3.28c-1 + 3.28c-2

---

##### 3.28c-5: Skill 发现验证（✅ 已完成重构）

**目标**：Agent 扫描 Skills 目录 → 根据 scope 匹配正确 Skill

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| 目录扫描 | manifest-loader 扫描 ~/.studio/skills/*/SKILL.md 读 frontmatter | 返回 SkillEntry[] |
| 三策略匹配 | skill-selector：子串+token(≥4字符)+4-gram 重叠 | 9/10 核心场景精确匹配 |
| NOT-for 排除 | 匹配时截断"不用于"之后内容 | 排除项关键词不触发误匹配 |
| Skill 注入上下文 | 选中的 Skill 内容注入 Agent 上下文 | Skill 内容出现在 Agent 上下文 |

**重构完成**（2026-06-24）：
- ✅ KEYWORD_MAP 已删除，改为 description 三策略匹配
- ✅ manifest-loader 改为目录扫描（零手动维护）
- ✅ 16 个 SKILL.md 全中文化
- ✅ 测试 31 个全过（skill-selector 15 + manifest-loader 10 + claim-skill 3 + e2e 8）
- ✅ 匹配精度 9/10（1 个轻微多命中：lifecycle-skill 因"知识库"4-gram）
- ⚠️ 端到端链路未验证（见 3.28c-6）

**开发流程重构**（2026-06-24）：
- ✅ 3 新 Skill：design-analyst（需求→spec）、task-planner（spec→SDD）、tdd-implement（SDD→代码）
- ✅ 3 Skill 升级：spec-review（动态路径）、sdd-review（并行审查）、code-review（并行审查+上游更新）
- ✅ session-analyst 废弃（拆分为 design-analyst + task-planner）
- ✅ trigger-eval 100% 精度（30 should-trigger + 30 should-NOT-trigger）
- ✅ execution eval 验证（isSimpleChange totalLines: RED 2 FAIL → GREEN 10 PASS）
- ✅ description 优化消除跨 Skill 关键词重叠
- ⚠️ Skill 触发机制根本问题未解（Claude 不主动调用通用 Skill）

**依赖**：3.28c-2

---

##### 3.28c-6: 端到端验证（⚠️ 未实际跑通）

**目标**：1 个完整 WorkUnit 生命周期跑通

| 任务 | 说明 | 验收标准 |
|------|------|---------|
| 验证场景设计 | 系统健康巡检（analysis 类型）| 场景文档化 |
| Trigger 创建 WorkUnit | cron → WorkUnit (type: analysis, channelId: ops) | Trigger 触发后 WorkUnit 创建 |
| Agent claim + 执行 | Agent 读 Channel → claim → 选 Skill → 执行 | Agent 自主 claim 并执行 |
| 结果写入 Channel | 执行结果 → ChannelMessage | Channel 可见结果 |
| WorkUnit → done | 状态流转完成 | 完整状态机流转 |

**审计确认**（2026-06-24）：
- ✅ 各组件单元测试通过（workunit e2e-lifecycle.test.ts、claim-skill-integration.test.ts、trigger 测试）
- ✅ Skill 发现 trigger-eval 100% 精度（3 新 Skill 验证通过）
- ✅ 单 Skill execution eval 验证（tdd-implement: isSimpleChange totalLines TDD 流程）
- ⚠️ **全链路未跑通**：Trigger → WorkUnit → Agent claim → Skill 发现 → 执行 → Channel 结果 → done
- ⚠️ Skill 触发机制：Claude 不主动调用通用 Skill，需要 CLAUDE.md 规则强制或 Terminal State 链触发

**依赖**：3.28c-1~5

---

**最小验证场景**：
```
Trigger (cron: "0 9 * * *")
→ CREATE WorkUnit (type: analysis, scope: "系统健康巡检", channelId: "ops")
→ Agent 读 Channel → 看到 WorkUnit → claim → 执行巡检 → 结果写入 Channel → done
```

**断点状态**（2026-06-24 审计）：
- ✅ WorkUnit Prisma 模型已实现（schema.prisma + migration）
- ✅ Goal → WorkUnit 迁移策略已确认（C. 渐进迁移，目标：最终只有 WorkUnit）
- ✅ Claim 机制已实现（乐观锁 UPDATE SET assigneeId WHERE NULL）
- ✅ Trigger Registry 已实现（YAML 配置 + cron + scheduler + REST API，设计选择非 Prisma）
- ✅ Channel 可见性已接入（ChannelMessage.workUnitId + 讨论空间端点）
- ✅ Skill 发现已重构：description 三策略匹配（子串+token+4-gram），零手动维护
- ⚠️ 端到端生命周期：各组件单元测试通过，全链路未实际跑通

**所有决策已确认**：
1. ✅ Goal → WorkUnit 迁移策略 → **C. 渐进迁移**（目标：最终只有 WorkUnit，需要监控迁移进度直到全部完成 + 回测正常）
2. ✅ Pipeline 和 Agent Network 并行期 → **B. 快速切换**（无共存期，但每个 Phase 需要：改动点清单 + 影响范围 + 回测范围）
3. ✅ Trigger 存储方案 → **配置文件**（系统内置 < 15 个，YAGNI）。**迁移触发条件**（任一满足 → 迁移数据库）：
   - Trigger 数量 ≥ 30
   - 用户请求自定义 Trigger（动态创建）
   - 需要 Web UI 管理 Trigger
   - Trigger 变更频率 > 1 次/天
4. ✅ Agent 何时读 MANIFEST → **B. claim 时读**（读 MANIFEST 清单 500 token → 按需读选中的 Skill 全文 1-2 个 1000 token。不缓存全部避免 7000 token 浪费）

**Commit**: `158295f9` — 34 files, +3384 lines, 160 tests all green

### Phase 3.29: 文档质量 Skill 体系 + 知识进化链路

**分析结论（2026-06-21）**：Agent Network 架构下知识飞轮分解为自动基建（事件监听+存储+索引）+ Agent 能力（extraction/quality/distillation skills）。

#### 3.29a: 文档质量 Skills（已完成）

| Skill | Pattern | 状态 |
|-------|---------|------|
| arch-review-skill | 概念完整性（对照 arch-patterns） | ✅ 已有 |
| sdd-review-skill | 三层一致性 + AC Group 覆盖 | ✅ 已有 |
| spec-review-skill | 结构完整性 + AC 质量 + 引用存活 + 就绪度 | ✅ 完成 |
| knowledge-quality-skill | 语义价值 + 矛盾 + 时效 + 去重 | ✅ 完成 |
| quality-loop → pattern | 6 步循环标准模式（不再是独立 skill） | ✅ 迁移完成 |

#### 3.29b: 知识进化链路（进行中）

知识进化完整生命周期：

```
创建 → 沉淀 → 消费 → 反馈 → 迭代/废弃
```

| 任务 | 类型 | 说明 | 状态 |
|------|------|------|------|
| knowledge-extraction | Loop-trigger Skill | 之前降级（User-trigger eval 0%）。重新设计为 Loop-trigger（每天自动提取）。Agent Network 下 Skill 有 User-trigger 和 Loop-trigger 两种触发模式 | ✅ 完成 |
| knowledge-synthesis-skill | Loop-trigger Skill | L2 定时综合扫描：语义模式检测 → skill 提议 + 经验教训综合 → 总结文档。输入面向 Agent Network 核心实体（WorkUnit/Channel/Knowledge/Event）。设计完成，待实现 | ✅ 完成 |
| harness knowledge patterns | CLI | 零 token 检测重复模式（替代 skill-distillation-skill） | ✅ 降级 |
| lifecycle-skill | Skill→降级 | eval 0% 触发率，职责已被 harness knowledge health/audit + knowledge-quality-skill 覆盖 | ✅ 降级 |
| flywheel-health CLI | CLI | 零 token 自动化检查飞轮数据流状态 | ✅ 完成 |
| skill-design-skill | Skill→降级 | eval 0% recall，设计讨论是抽象对话，模型认为可直接进行。转为 pattern 参考文档 | ✅ 降级 |
| spec-review-skill D3 扩展 | 质量门 | D3 增加依赖概念对齐检查（读 dependency 文档，提取核心概念，验证设计正确使用）。防止设计文档不对齐架构需求 | ✅ 完成 |
| loop-mechanism-design | 架构设计 | Agent Network 下周期任务机制。Trigger CREATE → analysis WorkUnit → Agent claim → Channel 可见。对齐 AS-025 核心概念 | ✅ 完成 |
| doc-manager-skill | Skill | 管理结构化文档：保存进度/创建 spec（含 dependencies frontmatter）/更新文档/更新 roadmap。解决 dependencies 声明问题 | ✅ 完成 |
| agent-network-core-concepts.md | 参考文档 | 从 AS-025 提取核心概念（WorkUnit/Claim/Channel/Agent/Skill/Trigger Registry），用于设计参考 + Review 对齐 | ✅ 完成 |

**关键设计决策（2026-06-22 更新）**：
- skill-distillation-skill 降级为 CLI：检测部分是零 token 工作，抽象概念部分由 skill-creator 覆盖
- lifecycle-skill 降级：eval 证明模型不会路由"清理/废弃/整理"类查询到 skill
- knowledge-extraction 重新设计为 Loop-trigger Skill：之前 User-trigger eval 0% recall 是因为触发模式错误。Agent Network 下 Skill 有 User-trigger 和 Loop-trigger 两种。知识提取适合 Loop-trigger（每天自动）
- skill-design-skill 降级：eval 证明模型不会路由设计讨论类查询到 skill（0% recall）
- **知识进化两层架构**：
  - L1 事件驱动提取（knowledge-extraction-skill）：单个事件 → 原子知识条目
  - L2 定时综合扫描（knowledge-synthesis-skill）：时间窗口知识集合 → 高阶洞察（skill 提议 / 经验总结）
  - L1 和 L2 本质不同：L1 是单次捕获，L2 是跨时间窗口的综合
  - L2 输入面向 Agent Network 核心实体（WorkUnit/Channel/Knowledge/Event），不依赖当前实现
  - 质量审查已由 knowledge-quality-skill 覆盖，L2 不重做
- **harness knowledge patterns CLI 降级**：使用场景不存在。模式检测是反思性活动（不需要即时性），knowledge-synthesis-skill 定时执行 + 输出持久化已足够。"零 token 快速检查"场景被现有工具覆盖（去重 → extraction Trace，搜索 → local-rag，模式检测 → synthesis-skill）
- **系统性发现**：
  - Skill 触发模式分两种：User-trigger（用户显式请求）和 Loop-trigger（定时自动）
  - User-trigger 有效的：具体工件审查（给文件 + "审查"）
  - Loop-trigger 有效的：知识提取、架构审核、知识综合
  - 两种都无效的：设计讨论（抽象对话）
  - **有效 skill 类型**：具体工件审查（给文件 + "审查/review"）、周期任务（知识提取/综合）
  - **无效 skill 类型**：设计讨论（抽象对话）、隐式行为（用户不会主动请求的）
- **激活模式模型**（五种）：CLI / User-trigger Skill / Loop Skill / Agent-call Skill / Pattern
- 四个降级 skill 的文件保留为参考文档

---

### Phase 3.30: Goal → WorkUnit 数据层迁移（Phase 1-5 + D1-D7 收尾 ✅ 2026-06-23）

**计划文档**：[goal-to-workunit-migration.md](plans/goal-to-workunit-migration.md)
**策略**：C. 渐进迁移，不双写。新逻辑直接写 WorkUnit，旧代码一次性标 deprecated。

#### Phase 1: WorkUnit 模型补列 + 转换工具（✅ 完成）

| 子任务 | 文件 | 验证 |
|--------|------|------|
| Schema 补列 | `schema.prisma` failureType/retryCount/timeoutAt + 2 索引 | migration SQL |
| WorkUnitMetadata | `workunit.service.ts` TypeScript 接口（10 字段） | tsc 通过 |
| Service 更新 | create/update/list 支持新字段 + failureType/timeoutAt 过滤 | 66 测试通过 |
| goalToWorkUnit | `goal-to-workunit.ts` Goal→WorkUnit + GoalPlan→子链 + Execution→状态同步 | 14 单元测试 |
| workunit.* events | `workunit-events.ts` created/claimed/status_changed/done | 5 事件测试 |

**验证**：66 测试通过，0 类型错误

#### Phase 2-5: 待执行

| Phase | 内容 | 状态 |
|-------|------|------|
| Step 0 | completedAt 列 + status-mapping 工具 | ✅ |
| Phase 2 LOW | evolution.service goalId→workUnitId | ✅ |
| Phase 2 HIGH | monitor-agent + okr.service 迁移 | ✅ |
| Phase 3 LOW | goal.service/routes/goalStore @deprecated | ✅ |
| Phase 3 HIGH | event-handler + scheduler-dispatch + goal-lifecycle | ✅ |
| Phase 4 | Pipeline 术语迁移 + 旧代码清理 | ✅ |
| Phase 5 | 集成测试重写 | ✅ |
| D1-D7 | 收尾：事件修复+状态机补全+17源码文件+9测试文件 prisma 迁移 | ✅ |

#### Phase 2: Agent Network 核心协调（✅ 完成 2026-06-23）

**Spec**：[agent-network-migration.md](specs/arch/agent-network-migration.md) Phase 2

| 功能 | 实现 | 状态 |
|------|------|------|
| WorkUnit CRUD + Claim/Unclaim | `workunit.service.ts` 乐观锁 `updateMany WHERE assigneeId IS NULL` | ✅ |
| dependsOn 环检测 | `cycle-detection.ts` 拓扑排序 DFS，O(V+E) | ✅ |
| Review API | `reviewPassed()` / `reviewRejected()` 语义方法 | ✅ |
| 连续 reject→block | 3x reject auto-block，`metadata._consecutiveReviewRejections` | ✅ |
| createFromMessage 涌现 | ChannelMessage→WorkUnit，链接 workUnitId | ✅ |
| 父子状态聚合 | 子→父自动计算（有序规则 + 状态守卫防竞态） | ✅ |
| 依赖解锁 | `blocked→active` 当所有 dependsOn 终态（done/closed） | ✅ |
| 文件冲突检查 | claim 时检测 `metadata.files` 与 active/in_review 重叠 | ✅ |
| EventBus 集成 | 8 事件：created/claimed/status_changed/done/unclaimed/review.passed/review.rejected | ✅ |
| AgentProfile CRUD | `agent-profile.service.ts` name + description + channels | ✅ |
| 测试覆盖 | 74/74 通过（workunit-api 54 + cycle-detection 14 + phase2-verification 6） | ✅ |

**Bug 修复**：closed→unlock、in_review 文件冲突、reviewPassed 事件一致性、级联竞态守卫、测试隔离

**下一步**：
1. Agent 失联超时释放（RuntimeInstance.lastHeartbeat + 定时扫描）
2. MVP 监控（WorkUnit 状态看板 + token 消耗 + Agent 在线状态）
3. L1 自动测试集成
4. Agent 间协作场景验证
5. ~~知识消费管道"最后一公里"（触发机制）~~ → ✅ 完成（2026-06-30）：AgentLoop hint（优先搜 `_index.md`）+ 知识库索引生成器（165条目，76-96% grep 输出减少）+ knowledge-quality-audit trigger（每日3:17 SCHEDULE → CREATE WorkUnit → Agent 自动执行 skill）+ 8 断点修复（BP-1~BP-8）

#### Phase 2.6: AS-026 Agent Persistence MVP（2026-06-24）✅

**Spec**：[AS-026-agent-persistence-mvp.md](specs/arch/AS-026-agent-persistence-mvp.md)
**SDD**：[agent-persistence-mvp/](sdd/agent-persistence-mvp/)

**路径 C：纯事件驱动** — TriggerRegistry + AgentLoop + Scheduler 退化

| AC | 内容 | 状态 |
|---|---|:---:|
| AC-1 | RuntimeInstance 表（schema ✅, CRUD API P2） | 部分 |
| AC-2 | Trigger 扩展 (EVENT+EXECUTE+UPDATE) | ✅ |
| AC-3 | AgentLoop 核心 (discover→claim→execute→review) | ✅ |
| AC-4 | 6 个默认 Trigger（含 knowledge-quality-audit） | ✅ |
| AC-5 | Scheduler 退化 (stale-recovery.ts) | ✅ |
| AC-6 | E2E 验证 (48 tests, 7 files) | ✅ |

**产出**：ceaba833, 19 files, +3413/-46

**Bug 修复 + 重构**（2026-06-25 session 1）：
- poll-fallback handler 未注册 → AgentLoop.start() 注册 agent-scan-workunits handler
- dependency-unlock 查询条件错误 → dependsOn 使用 $event.id 模板变量
- stale-recovery handler 是死代码 → 删除
- AgentLoop skill 注入去除 → session-manager formatForPrompt + loadSkill MCP 接管（-171 行）

**Bug 修复 + 重构**（2026-06-25 session 2）：
- #3 AgentLoop 绕过 WorkUnitService → tryClaim() 改用 workUnitService.claim() + transitionStatus()
- #4 ExecutionResult.success 被忽略 → success=false 时 unclaim 而非 in_review
- SCHEDULE triggers 不触发 → index.ts 加 registry.start() 启动 tick interval
- null store 崩溃 → trigger-scheduler.ts start() 加 if(this.store) 守卫

**P2 遗留**：
- ✅ #672: AC-1 CRUD API (agent-instance service + routes)
- ✅ #673: 消除 agent-loop.ts 的 as any 类型断言（31→0，24/24 tests PASS）

**Skill Chain 优化**（2026-06-25 session 3）：
- Skill 注册修复：9 个 symlink 补全（`~/.claude/skills/` ← `~/.studio/skills/`）
- 路由优化：快速退出替代外部前置检查（5 个 skill 改造）
- 完整链路实测：design-analyst(快速退出) → tdd-implement → code-review ✅
- token 节省：小改动 ~85%，中等 ~47%

**Agent Loop 重写**（2026-07-02）：
- SDD：[agent-network-loop-rewrite/](sdd/agent-network-loop-rewrite/)
- 架构变更：EventBus 驱动 → Polling 决策循环（observe→resolveTarget→agentStep→recordResult→sleep）
- ACTION 协议：Agent 输出 `ACTION: PROGRESS|COMPLETE|NEED_INPUT:<summary>`
- 删除 6 文件（workunit-events/cycle-detection/channel-message.events + tests）
- 347 测试 PASS + tsc 0 errors + 3 Critical 修复（C-1/C-2/C-3）
- E2E 验证 3/3 PASS（ACTION 协议/Session resume/自主推进）
- Commits: `040e43f` → `9ad005e` → `0312555` → `be4f751` → `d8fbd56` → `ccca3ae`

**SDD 生命周期设计决策**（2026-07-02）：
- 问题：50+ SDD 目录 status 不准 → Agent 搜索噪音
- 方案：Git 作为反向索引（`git blame` → commit → SDD slug → 设计文档）
- 前提：tdd-implement ⑦ 保证 SDD status 准确（全量验证后自动更新 status → implemented）
- Skill 更新：tdd-implement + code-review 自检表

**下一步**：
1. Phase 2 拆分为 6 个独立 MVP（每个可独立测试）
2. ~~知识消费管道"最后一公里"（触发机制）~~ → ✅ 完成（2026-06-30）

**Phase 2 MVP 拆分**：
- MVP-1: WorkUnit 页面（列表+创建+状态筛选）
- MVP-2: AgentDashboard（AgentProfile+RuntimeInstance 状态）
- MVP-3: 审查界面（in_review→done/reject）
- MVP-4: 讨论空间 UI（ChannelMessage 关联 WorkUnit）
- MVP-5: Agent 失联超时释放
- MVP-6: MVP 监控看板

#### Phase 2.5: Skill 全量升级 + 触发机制调研（2026-06-23~24）

**Spec**：[workflow-enforcement-analysis.md](specs/design/workflow-enforcement-analysis.md)

**问题**：Phase 2 开发流程违反 TDD（先实现后测试），review 后置。根因：CLAUDE.md 规则是背景噪音，Skill HARD-GATE 是前景指令。

**完成项**：

| 步骤 | 内容 | 状态 |
|------|------|:---:|
| Phase 1 | 4 个开发链 Skill 注入 HARD-GATE + Anti-Pattern + Terminal State + Self-Review + Integration | ✅ |
| Phase 2 | eval 验证（4 Skill × 3-4 场景）+ 修复共性缺陷（Terminal State→HARD-GATE） | ✅ |
| 7 Skill 升级 | arch-review/sdd-review/spec-review/knowledge-extraction/knowledge-synthesis/doc-manager/test-diagnosis 注入 Anti-Pattern + Self-Review | ✅ |
| eval 验证 | 7/7 全部 100% 触发准确率（20/20） | ✅ |
| Description 标准化 | 全部 13 个 Skill 改为 "Use when/for" + "NOT for" 格式 | ✅ |
| parallel-execution | 新建执行协议 Skill（参考 superpowers subagent-driven-development） | ✅ |
| Phase 4 | Evolution 生成 Skill 条件更新（强制机制必填） | ✅ |
| Skill 定义进化 | 6 种类型 + 质量机制因类型而异 + Skill 本质定义 | ✅ |

**Skill 链**：`session-analyst → tdd-red → tdd-green → code-review`

**触发机制调研结论**：
- Claude 只在"认为需要帮助"时调用 Skill（专业任务自动触发，通用任务不触发）
- description 优化（"如何"→"Use when"）无效
- Claude Code 会话：接受手动触发
- Agent Network：未解决（Skill 发现机制待设计）

**待解决**：
- [ ] Agent Network 中 Agent 如何可靠发现并触发 Skill（元数据匹配率低，无 Orchestrator，无人值守）
- [ ] 开发链端到端串联验证（Terminal State 是否真的能 invoke 下一个 Skill）

### Goal/WorkUnit 分离 — 遗留类型错误（2026-06-27 排查）

**背景**：Pipeline（Goal）和 Agent Network（WorkUnit）已彻底拆分为独立系统。Phase 1-3.5 迁移完成（bc7fd33b → 8a2c17dd → c5b926a1 → 64a980fb），但 6 个文件未被触及。

**初始修复（已废弃）**：d7a5ed82 将 goals 模块中混用 WorkUnit 字段的 GoalExecution 查询改为 WorkUnit 查询，TS 错误清零但方向错误 — goals 模块仍查询 WorkUnit 表，违反 AC-1.x 隔离要求。

**正确修复（2026-06-29）**：将 scheduler-integration.ts、scheduler-prompt.ts、event-handler.ts、stale-recovery.ts 中的 WorkUnit 查询全部改为 Goal/GoalExecution 查询。事件订阅从 `workunit.*` 改为 `goal.*`。

**修复计划**：[goal-workunit-type-errors/fix-plan.md](sdd/goal-workunit-type-errors/fix-plan.md)

| 优先级 | 文件 | 问题 | 状态 |
|--------|------|------|------|
| P0 | scheduler-integration.ts | 11 处 workUnit → goal/goalExecution，事件 workunit.* → goal.* | ✅ |
| P0 | scheduler-prompt.ts | 4 处 workUnit → goalExecution，metadata → input/output | ✅ |
| P0 | event-handler.ts | WorkUnitService → goalService，workunit.done → goal.executionDone | ✅ |
| P0 | stale-recovery.ts | workUnit → goalExecution，状态枚举修正，函数重命名 | ✅ |
| P1 | goal-lifecycle.ts | updatedAt 不存在 + goalMeta 未定义 | ✅ |
| P1 | auth.ts | workspace ownership 引用不存在字段 | ✅ |
| P2 | goal.service.ts | deprecated 函数签名不匹配 | ✅ |

**状态**：✅ 彻底完成（tsc 0 errors, 273/273 goals tests, 129/129 workunit tests，双向隔离验证通过）

**隔离验证**：goals 模块无 `prisma.workUnit` 代码引用，workunit 模块无 `prisma.goal/goalExecution` 引用（除迁移工具 goal-to-workunit.ts）

---

### Pipeline 废弃 — Phase 1-4a（✅ 完成 2026-06-30）

**Issue**：[2026-06-29-pipeline-deprecation-analysis.md](issues/2026-06-29-pipeline-deprecation-analysis.md)

| Phase | 内容 | 状态 | commit |
|-------|------|------|--------|
| Phase 1 | MonitorAgent/OKR 查询迁移（Goal→WorkUnit），boundary test 隔离，外部消费方清零 | ✅ | `5b450d3` `0cb3f45` |
| Phase 2 | 价值提取：3 工具函数→studio-shared + 5 知识条目→knowledge/ | ✅ | `d4b331e` `8bacc73` |
| Phase 3 | 18 个 .ts 文件 @deprecated + DEPRECATED.md | ✅ | `c85c2d1` |
| Phase 4a | 残留代码清理（dashboard→503, auth→删 case goal, alarm→删 DB 写） | ✅ | `da47faa` |
| Phase 4b | 删除整个 goals/ 目录（触发条件：30 天观察期，2026-07-30 可执行） | ⏳ 待执行 | — |

**Phase 2 提取产出**：
- `packages/studio-shared/src/utils/concurrency-control.ts` — getDispatchStrategy/getAvailableSlots/updateDispatchOutcome
- `packages/studio-shared/src/utils/error-file-extractor.ts` — extractAffectedFiles（3 层 pattern）
- `packages/studio-shared/src/utils/git-utils.ts` — forceCommit
- `~/.studio/knowledge/pattern-dag-wave-scheduling.md` — Kahn 拓扑排序 + DFS 循环检测
- `~/.studio/knowledge/pattern-task-tier-routing.md` — 多维分类 + ε-greedy 探索
- `~/.studio/knowledge/pattern-cascade-rollback.md` — 5 种 failureType + BFS 级联
- `~/.studio/knowledge/pattern-prompt-context-injection.md` — 三层 prompt 注入 + sibling context
- `~/.studio/knowledge/pattern-worktree-state-reconciliation.md` — 超时扫描 + worktree 状态仲裁 + 三路分发

**Phase 4b 触发条件**：
- Phase 1-4a 全部完成 ✅
- 30 天观察期 — GoalScheduler 2026-06-30 禁用 → 2026-07-30 可删
- OKR 历史数据 — 确认无需迁移（Pipeline KR 随系统废弃失效）

---

### ~~待解决：知识消费管道"最后一公里"~~ ✅ 已解决（2026-06-30）

**Issue**：[2026-06-23-knowledge-consumption-last-mile.md](issues/2026-06-23-knowledge-consumption-last-mile.md)
**解决方案**：
- AgentLoop execute() 注入知识库绝对路径 hint，优先搜 `_index.md`（165条目25KB）
- 知识库索引生成器 `KnowledgeIndexGenerator`：`harness knowledge index` CLI
- 触发机制：`knowledge-quality-audit` trigger（SCHEDULE cron 3:17 → CREATE WorkUnit → agent-discover → AgentLoop → Agent 执行 knowledge-quality-skill）
- 8 断点全部修复：title-duplicate null guard / 22 unknown type → 0 / synthetic ref 过滤 / fragment-cluster 规则 / audit 后自动重建索引 / skill ⑦ 索引重建步骤

---

### P9 外部算力接入（待讨论，spec 已存在）

**Spec 文件**：[external-agent-runtime.md](specs/arch/external-agent-runtime.md)

**目标**：Studio 从"执行者"变为"调度者" — 外部算力节点连接 Studio，注册 agent，Studio 分发任务，算力方付 token。

**待讨论**：
- [ ] 算力节点注册协议（怎么连上 Studio）
- [ ] Agent 能力发现（自动扫算力上的 agent，识别能力）
- [ ] 任务分发模型（Studio 推任务 vs 算力拉任务）
- [ ] 结果回收（外部 agent 完成后回报结果的协议）
- [ ] Skill 如何映射到不同 agent（Claude Code / Cursor / 自定义 CLI）
- [ ] 费用模型（算力方承担 token，Studio 只做调度）

**状态**：Spec 已设计（Skill 格式 + Agent Loop），运行时接入未设计。

---

> 详细内容见 git log。
