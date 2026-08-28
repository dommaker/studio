# apps/api/src/modules/agents

### 职责

Agent 配置（profile）、运行实例（instance）、决策循环（loop）及内部审计 Agent（Auditor/Monitor/Knowledge/Triage/Ops）编排。REST API CRUD + 事件驱动自动挂载/运行/终止。

### 目录结构

- `loop/` - 决策循环与 WU 执行链（agent-loop 拆分、executor、completion-gates、wu-verification、execution-step-events、review-contract、lease-heartbeat、context-overflow）
- `auditor/` - Auditor Agent（service/rules/execution/reports/review-adapter）
- `monitor/` - Monitor Agent（service/probes/system-probes/alerts/reports/lifecycle）
- `ops/` - 进程级守护（ops.service/ops-rules/proc-probes/system-health）
- `knowledge/` - 知识维护 Agent（curator/cold-start/extraction/maintenance）
- `triage/` - Triage Agent（triage.service；incident-store = incidents.jsonl append-only）
- 根目录 - 共享与 CRUD：routes、types、agent-profile/*、agent-instance/*、token-usage/*、default-provider、default-triggers、system-executor、session-summary.service、requirement-gate

### 核心导出

- `monitor/` - monitor.service（门面，5min 轮询健康监控+渐进告警）、monitor-probes（WU 级探测：失败趋势/停滞/超时/池停滞/评审停滞/僵尸认领守卫）、monitor-system-probes（系统/知识级探测与自修复）、monitor-alerts（告警分发/Triage 升级，指纹冷却去重 w4h/c1h）、monitor-reports（轨迹评估/每日洞察/交互观察）、monitor-lifecycle（知识沉淀闸门+每日 TTL 清理）
- `ops/` - ops.service（preflight 启动检查/health 轮询自愈/代理守护/worktree GC/默认数据 ensure）、createHealthRoutes（/healthz 健康端点）、proc-probes（#344：/proc 系统探测单出口——statfs 磁盘/meminfo 内存//proc/*/stat 僵尸//proc/loadavg，零子进程；#374 起 ops.getStatus、monitor systemHealthCheck、ops preflight 磁盘检查三处同源委托）
- `auditor/` - auditor.service（门面，24h 日审跨任务审计）、auditor-rules（错误归类/技能建议/用户模型质量/知识健康）、auditor-execution（低风险自动应用/确认卡片经 review-proposal 正本发卡/Resolution/Triage 升级）、auditor-reports（行为趋势/七日趋势/tier 反馈）、review-adapter（#356：auditor_suggestion 卡接线 review-proposal 正本，kind=auditor，onApprove 建未指派 task 工单——自旧 channels/card-decision.service 搬入；审批走通用端点 /review-proposals/auditor/:id/*）
- `knowledge/` - knowledge-curator.service（门面，冷启动+每日维护）、knowledge-extraction（提取 prompt 单一来源）、knowledge-cold-start（四源导入 docs/code/git/manual）、knowledge-maintenance（语义去重/质量评估/过期验证/矛盾审查）
- `loop/` - agent-loop（循环编排，拆分后仅保留类逻辑+re-export；#363：原 start() 同角色 terminated 启动清理已拆除，回收归 instance-timeout-scan）、agent-loop.types（类型契约，纯类型零运行时）、agent-loop-parsers（输出解析+prompt 模板纯函数）、agent-loop-events（tokens/tool:call 落盘，provider 分流 usage；#320 起 workunit:tokens 落盘后顺带 `noteTokenLedgerWritten` 更新 token 账本 `utils/token-ledger`，失败隔离）、agent-loop-guards（测试 WU 守卫+excludeAssignee）、lease-heartbeat（WU 租约心跳 30s，fencing 校验）、context-overflow（溢出识别+滚动摘要）、executor（Executor 接口，LocalExecutor 委托 agentRunner）、execution-step-events（步级事件落盘+步内流式 SSE）、wu-verification（自动验证可复用实现）、completion-gates（收口守卫链：提交/子任务/验证/软观测）、review-contract（verdict 语义单一来源 pass/reject/needs-info）
- 根目录 - default-triggers（9 个系统 trigger：inspection-scan/dispatch-reconciliation/doc-semantic-review 等）、agent-loop.ts（门面，决策循环编排+re-export）、agent-output-parser（ACTION 协议解析/审查结论/任务拆分/动态间隔）、prompt-composer（prompt 组装，分段软定额截断）、agent-loop-workspace（worktree 解析/归属链/PMO 分支）、session-resume（续用判定+上限 MAX_SESSIONS_PER_WU=5）、agent-targeting（Observations->Target 解析）、default-provider（provider 默认选取）、instance-timeout-scan（心跳过期 5min 扫描+pid 复核；#363：统一回收 terminated 实例——跨角色 deleteState 连带判空删目录，闭环实例目录生命周期）、dispatch-reconciliation（派工/评审断链 5min 对账）、workunit-token-events（tokens/tool:call 事件写入）、agent-loop-utils（进程存活/git 根/worktrees 工具）、wu-test-guards（测试特征 WU 判定）、agent-loop-instance-state（实例状态：启动失败/idle 心跳/忙闲 SSE）、agent-loop-record-result（recordResult：提交/子任务/验证+状态迁移+里程碑）、agent-loop-step-guards（前置守卫：测试 WU 关闭/token 预算熔断）

### 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus/FileStore/logger/memoryStore）、`@dommaker/studio-agent`（agentRunner/AgentTask）、`../workunit`/`../knowledge`/`../triggers`/`../workspaces`、子模块 auditor/*
- 下游：`apps/api/src`（路由挂载+启动初始化）、`modules/knowledge`（依赖 knowledge-agent.service）、`modules/workunit`（waiting-input.ts 引用 agent 实例）

### 注意事项

- **AgentProfile 持久化**：`~/.studio/data/agents/{id}/profile.json` + `state.json`；原子写+mkdir 锁，仅可显式 DELETE；保留名 `studio`
- **prompt 注入 = index-on-demand**：skills 只注入 name+description+triggers+指针，正文不注入；知识分层（rule/context 全量、signal 索引、reference 报条数）；分段软定额+池内余量共享截断（persona 300/roster 400/skills 600/map 800/memory 300/knowledge 1000/files 400/contract 200/handoff 800）；段序 persona->roster->skills->map->memory->knowledge->files->base->contract->handoff->hint
- **三层超时**：步墙钟 1800s 兜底+静默看门狗（300s warn/600s 杀进程组）+maxTurns=50
- **Idle 心跳 45s**，超时扫描 5min；**isOnline** = loop 存活+心跳新鲜（≤5min）；#345 起 isOnline/每角色最新 error 聚合单源 `summarizeRoleStates`（agent-instance.service），agent-profile list 与 instance-timeout-scan 的 5min 窗口同源（INSTANCE_ALIVE_TIMEOUT_MS）
- **系统探测 /proc 单出口（#344）**：新探测先落 `ops/proc-probes.ts`（零子进程）。磁盘 = statfs (blocks−bavail)/blocks（含 root 保留块，比 df Use% 偏高 1–5pp）；内存 = MemTotal−MemAvailable（比 free -m used 列偏小，现代可用口径）；僵尸 = /proc/<pid>/stat state=Z。monitor systemHealthCheck 阈值不变（disk>90 warning / mem>95 critical / zombie>0 warning），details 的 dfOutput/freeOutput 已随 shell 解析删除，保留 usagePercent/zombieCount；ops 残留 ss/systemctl/countProcesses 走 async exec
- **monitor-round 零同步子进程（#374）**：全部同步 exec 收口（review 补收票面漏列的第四处）——gcStaleWorktrees `git worktree prune`（cwd/5s timeout 语义不变）与 checkKnowledgeHealth `npx harness update-user-model`（30s timeout、`|| echo "{}"` shell 兜底不变）改 `monitor/exec-async.ts` 异步 exec；dailyReflection git log/diff 改 execFileAsync（数组参数不经 shell 语义不变）；ops preflight 磁盘 df 解析第三副本删除，委托 proc-probes.readDiskUsage（message 保真 Use% + available，statfs 不可用 → skip 不 fail）。preflight 其余同步 exec（vite build/lsof/cloudflared/进程清理）为启动一次性路径，#374 方案未列，保留
- **多实例单活**：`STUDIO_AGENT_LOOP_ENABLED=false` 实例 standby；`AgentLoop.start()` 内置同角色单活守卫
- **SSE 负载含 channelId（2026-08-24 SSE 负载加深，批 1）**：`workunit.execution.step` / `workunit.execution.stream`（含 step-start）负载与 `workunit.tokens` SSE 信封 data 均携带 `channelId`（wu.channelId 透传，无频道 WU 缺省该键）——前端按频道过滤 step/token 事件的数据源；`workunit:tokens` 落盘后顺带经 eventBus.publish 发 SSE（best-effort，不落盘二次）
- **派单链**：WorkUnitService.create -> workunit.created -> TriggerScheduler -> AgentLoop.observe（15s 轮询兜底）-> 过滤 -> claim -> agentStep -> LocalExecutor -> spawn CLI -> recordResult -> 回帖（EventBus/SSE）
- **observe 读路径优化（#330）**：observe 调 `queryAllMessages` 传 myActive WU 的 channelId 集合做频道预过滤（任一活跃 WU 无 channelId 退全扫；已接受盲区 = WU 换频道后旧频道新回复不扫）；loop start 订阅 `channel.message_sent`（eventBus 同进程，human 且 workUnitId ∈ myActive 命中即打断空闲 sleep 立即 observe，stop 退订）——空闲兜底轮询维持 15s 不变（事件 fire-and-forget 无持久，防跨进程写者/重启间隙）
- **F4 review 派发**：父 in_review -> 建未指派 review 子 WU 走 claim 涌现；excludeAssignee 禁自领；同父唯一性 flock 锁
- **R3 评审契约**：评审子 WU scope = diff-only+`+code-review`；needs-info -> 转人工
- **不派评审类型**：decision/spec/analysis 走人工 in_review
- **F6 台账**：COMPLETE 前验证守卫写 l1；`POST /workunits/:id/verify` 人工重跑；`POST /workunits/:id/dispatch-review` 人工补派
- **WU 租约心跳**：每 30s 推前 timeoutAt（now+5min），fencing（claimedAt 代际令牌+assigneeId 双比对）；#314 起每跳只写内存缓冲，FileStore flushWorkUnitLeases 默认 60s 窗口锁内复核 fencing 后合并落盘；易主 -> 停跳+onLost
- **CLI 上下文溢出**：纯反应式 -> 滚动摘要落盘 -> 新会话带摘要重试 -> 再败 NEED_INPUT
- **子 WU 不继承会话簿记**：clearSessionBookkeeping 清除 14 字段（sessionId/startedAt/sessionResumes/sessionCount/lastSessionResumed/blockReason/stepCount/consecutiveStuck/errorType/errorDetail/errorAt/_cumulativeTokens/progressLog/sessionSummary）；新增簿记字段必须同步
- **鉴权**：POST/PUT = requireAuth()+requireNotGuest()；terminate = requireAuth()+requireAdmin()
- **SystemExecutor 输出形态（#364）**：claude 模板固定带 `--verbose`，`--output-format json --verbose` stdout 是单行 stream-json 事件数组（产出与 usage 在末位 `type=result` 事件），非单 envelope；`extractResultEnvelope` 统一归一两种形态，mock CLI 输出时必须按真实形态（数组）写，否则测试绿生产哑
- **SystemExecutor 按源超时（#369）**：`run()` 超时解析 = 显式 `timeoutMs` > `DEFAULT_TIMEOUT_BY_EVENT_SOURCE[eventSource]` > 30s 全局默认；注册表收编重 prompt 源 knowledge-distill / constraint-audit / knowledge-maintenance =120s（依据 #365 实测蒸馏 21-27s 撞 30s）。新调用点必须带 eventSource（同时是 system:tokens 成本聚合键）；轻源不进表走裸 30s，durationMs 遥测贴上限再评估
- **system:tokens 写通路可观测（#370）**：写入成功打 info 日志（eventSource/provider/durationMs），失败 warn 带 eventSource——"零产出"与"静默失败"可区分；#370 实证写链路本身无 bug（冒烟脚本 `scripts/system-tokens-smoke.ts` 直接 `getSystemExecutor().run()` 验证落盘），零产出根因是全部 13 个调用方事件驱动、环境未触发
- **频道发声**：里程碑+异常+每步简报+认领消息+步失败消息；认领/失败消息不过新鲜度检查
- **认领门槛**：纯显式，三门槛：assigneeId 排他+excludeAssignee+blockedBy 依赖门禁
- **失败步埋点**：recordOutcomeEvent 落 knowledge:outcome:failure/success
- **Auditor 零执行早退**：24h 零执行不 push 不记录不升级
- **WU 收尾提取**：订阅 done -> 读 transcript -> LLM -> 角色记忆草稿区；与 R3 并行独立
- `AgentLoopRegistry.mount()` 幂等不抛错；Agent 数据均 FileStore 存储；审计日志写 `~/.studio/logs/studio-events.jsonl`
- **token 视图读口窗口化（#342，2026-08-27）**：token-usage.service 三个事件读点（getAgentTokenUsage / aggregateTreeTokens / sumTokensForWorkUnits）切 `readStudioEventsSince` 窗口读（30d = #173 事件热保留期，先例 #335 wu-changed-files）；**totals / 树聚合 rootTotal / PMO 台账求和口径从「文件全量」收敛为 30d 窗口内**——生产热文件本就 ≈30d（轮转切冷包），差异仅在轮转滞后时段可见；NaT（无 createdAt/timestamp）行不再计入累计（读口统一跳过，#335 auditor 口径修正同款）；getAgentTokenUsage 的 30s 缓存与 `opts.now` 注入口径不变（sinceMs 由同一 now 派生，测试确定）
- instance 忙闲 SSE：agent.instance.status_changed，内存去重。#312（2026-08-24 SSE 负载契约体检）：负载 additive 带 `currentWorkUnit` 快照（逐字段对齐 getAgentSummary：title = metadata.title ?? scope；悬空 WU → null 裸 id 保留）+ `channelId`（当前 WU 所在频道）+ `lastError/lastErrorAt`；发布面 active/idle 扩到 error（recordStartupFailure 路径，agent.health.failed 保留），terminated 不发。#318：负载再添 additive `pmo` 快照 + `startedAt`；WU 聚合上下文走共享出口 monitoring/current-wu-context.ts（与 getAgentSummary 同源，claimedAt 快照原样透传）；负载构造唯一出口 buildInstanceStatusPayload（publishInstanceStatus / recordStartupFailure 共用）
- A2A：ACTION: DELEGATE:@<profileName>:<scope> 建子单+发 delegate 卡片
