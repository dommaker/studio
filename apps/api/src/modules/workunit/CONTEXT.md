# apps/api/src/modules/workunit

### 职责

WorkUnit 核心域: 任务单元 CRUD、认领与状态机; F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。

### 核心导出

- `workunit.service.ts` - Service 门面: CRUD + Claim + 状态机, claim 写 5min 租约(持有方 30s 心跳推前), 收口 reviewPassed/reviewRejected/attestation 幂等补写/markMergeConflict/blockForManualRelease。导出 `waitForReviewPassSettled()` 供测试等待异步自动合并收尾。
- `workunit.types.ts` - 类型契约 + 状态机表: WorkUnitMetadata / DTO / VALID_TRANSITIONS / TYPE_VALID_TRANSITIONS + resolveValidTransitions / WU_LEASE_TTL_MS(5min) / ANALYSIS_TASKS_MAX(8) / INSPECTION_OPPORTUNITIES_MAX。
- `workunit.mappers.ts` - 快照 <-> DTO 转换: snapshotToData / inputToSnapshot / patchSnapshot。
- `workunit-crud.ts` - WorkUnitCrudService(基类): CRUD + Claim(flock 悲观互斥锁) + 快照转换 + publishStatusChanged + aggregateParentStatus。
- `workunit.routes.ts` - API 路由。
- `waiting-input.ts` - F5 双向沟通 + 回复即复活(全 blocked 类型): 线程人类回复 -> active + pendingReplies 注入; ownership 挂起按工程归属解析(project-discovery 唯一命中 -> 绑定 + 写回 Requirement.projectId + 置 unassigned); wu-token-budget 按人三选分流; Web 按钮 POST /:id/resume + /:id/close 复用原语。
- `blocked-cta.ts` - blocked 消息统一 CTA 模板: withBlockedCta / buildDeadLetterNotice。
- `wu-closure.ts` - 系统推 WU -> closed 统一出口 closeWorkUnitWithNotice(快照 + workunit:closed 事件 + 频道说明, 各步 best-effort)。
- `wu-messenger.ts` - WU 频道系统消息统一出口 postWuSystemMessage(走 ChannelMessageService.createAgentMessage: append + eventBus + SSE); milestone:true 解析 pmoId + atHuman:true; lazy import pmo-branch-resolver 避环。
- `timeout-release.ts` - 超时 WU 释放回 unassigned(≥3 次转 blocked), 释放即杀原 holder 进程组(kill(-pid, SIGKILL); pid 复用按 /proc 启动时间与 startedAt ±10min 比对兜底); decision 单不进扫描。导出 `pidStartMatchesInstance` 供 agents/instance-timeout-scan 复用。
- `delegation-gate.ts` - A2A 委派闸门(纯代码): 成员/自派生/深度1/宽度3/树8/环/重复委派校验, 预算留桩。
- `merge-on-review-pass.ts` - 评审通过后自动合并: task/<wuId> --no-ff 合并回目标分支, 冲突 rebase 重试一次, 仍冲突置 blocked(转人工走 markMergeConflict); pmoBranch 走 PMO 分支交合 worktree(`<worktreesDir>/pmo-<projectId>`)。
- `wu-metadata.ts` - metadata 访问器(零依赖叶子): parseWuMetadata(容错解析) / parseWuTitle(展示名 title??scope 唯一出口, #312 起 getAgentSummary 与 status_changed 负载共用) / clearSessionBookkeeping(16 字段会话簿记权威清单, review 子 WU 不继承) / mergedWuView(持久化 + metadataUpdates 合并视图)。
- `wu-dependencies.ts` - 接单依赖判定(零依赖叶子): parseBlockedBy / buildStatusById / hasUnfinishedDeps / resolveClaimable。
- `assignee-resolver.ts` - assigneeId 双语义批量解析器: buildAssigneeProfileResolver -> (assigneeId) => profileId | null。

### 依赖关系

- 上游: @dommaker/studio-shared(eventBus、FileStore)、projects(project-discovery 候选搜索)、requirements(Requirement projectId 写回)、pmo(projectService 查/建 gitRepo 锚点项目)
- 下游: agents(AgentLoop 认领执行)、requirements(状态汇总)、channels(@mention 派发)、triggers(CREATE 动作)

### 注意事项

- **assigneeId 双语义**: unassigned 时 = 被指名 profile.id; 认领后 = 认领方 loop 的 instance.id。claim 锁是 flock 悲观互斥锁(mkdir 原子目录跨进程互斥)。token 归因按双语义解析, 批量消费方统一走 assignee-resolver, 勿各自再建 map。
- 状态变更发 workunit.status_changed 事件(claim/unclaim/reviewRejected 也发), requirements/rollup 据此汇总 REQ 状态。订阅方: events/workunit-events-bridge(->SSE)、pmo/analysis-handoff(分析接力)。
- **租约 + 代际令牌(fencing)**: timeoutAt 语义 = 租约到期, claim 写固定 5min(WU_LEASE_TTL_MS), 持有方 loop 每 30s 心跳推前(#314 起 refreshWorkUnitLease 只写内存缓冲, flushWorkUnitLeases 默认 60s 窗口锁内复核 fencing 后合并落盘——持久化 timeoutAt 滞后 ≤60s ≪ TTL, 扫描逻辑零改动)。claimedAt 作 fencing token, 三处校验: 心跳前(快速路) / 步结果回写前(stillHoldsLease) / 状态迁移前(transitionIfHeld)。易主即杀 CLI 进程组(Executor.stopProcessGroup -> kill(-pid)) + 停心跳 + 静默退出该 WU。释放即杀: 释放/转 blocked 后顺 assigneeId 杀原 holder。
- **blocked 恢复**: 不做自动恢复。回复即复活 -- 全 blocked 类型, 线程人类回复 -> active + pendingReplies 注入, 回复「关闭」= 显式关闭指令(decision/spec 无 closed -> 拒绝并说明)。复活重置 consecutiveStuck/blockReason, 记 resumeCount(不限次), timeoutReleaseCount 终身保留。CTA 统一 blocked-cta 模板(blocked 里程碑/30min 提醒/24h 死信)。24h 死信自动关闭(计时基准 = metadata.blockedAt, 无则回退 createdAt; decision/spec 豁免), 经 wu-closure 双出声。checkTotalExecutionTime 2.5h 强杀同出口。复活后凭 metadata.sessionId 优先续用旧会话(不靠清零 sessionCount 放行)。
- **decision/spec 类型裁剪状态机**: `unassigned -> active ⇄ blocked -> in_review -> done`, 无 closed(决策可等关键人多天, 不进死信/关闭)。TYPE_VALID_TRANSITIONS 按 type 覆盖, transitionStatus 经 resolveValidTransitions(type, status) 查表, 未列出 type 回落全局 VALID_TRANSITIONS。不在 CODE_WORKTREE_TYPES(无 worktree/无 L1 验证 -> merge-on-review-pass 自然旁路), ReviewDispatcher 不派评审子 WU, PMO 证据口径豁免 l2。
- **pending 待确认人闸**: PENDING_CONFIRM_TYPES = feature/task/spec 创建未显式给 status -> 落 pending(状态机仅 `pending -> unassigned|closed`, spec 走裁剪机仅 `-> unassigned`), 人工确认才进 frontier。feature 落 pending 不展开频道默认管线, 确认时 transitionStatus 补展开(幂等)。resolveInitialStatus(type, explicit?) 是初始状态唯一决策入口(workunit.types.ts)。
- **F6 证据台账**: metadata 增 attestations(l1 自动验证 / l2 agent 评审 / l3 人工确认)。展示/指标只准过 studio-shared 的 deriveDisplayState(), 禁止各自解释。5 处写入(reviewPassed/writeHumanConfirmation/writeAgentReviewAttestation/recordL1Verification/reviewRejected)收敛为 buildAttestationEntry / persistSnapshot。
- **接单依赖**: blockedBy 任一未了结(非 done/closed) -> unassigned 对所有 loop 不可见。引用缺失 id 保守按未了结(笔误保护)。GET / 列表项附 claimable 标记供 UI；#318 起 workunit.created/status_changed 事件负载同样附 claimable（additive，口径一致：unassigned 且无未了结依赖才 true，其余恒 false 不读 index；resolveEventClaimable @ workunit-crud.ts）。
- **开图/物化/收尾哨兵**: analysis WU done 且 l3.summary 含 `FOG:`/`DESTINATION:` -> 初始化 PMO map + 逐条建 decision 单(metadata 落 mapOpenedAt 哨兵 + pmoId/fogId 互挂契约); spec WU done 且 l3.summary 含 `TASK:|AC:|BLOCKEDBY:|LEG:` -> 批量建 task 单(specTasksSpawnedAt 哨兵); done 触发角色记忆提取(memoryExtractedAt 哨兵)。各哨兵写入走「写入前重读合并」防同事件互覆。
- **并发写收口**: 全部快照写路径走 FileStore 锁内 commitSnapshot/commitRemoval(appendEvent + upsertSnapshot 同一把 workunits flock 成对, 删除落 closed+deleted 墓碑); metadata 增量写走 updateMetadata(id, mutator)(mutator 基于锁内最新 metadata, stepCount/consecutiveStuck 锁内重计, progressLog/pendingReplies 锁内尾部追加); createGuarded(input, guard) 支撑 review 建子 WU 锁内 check-then-create; 启动对账 reconcileIndex 接 apps/api index.ts。
- **metadata 字段承载**: workspaceRoot/ownershipSource/waitingReason(工程归属); worktreePath/worktreeBranch/worktreeBaseBranch/worktreeBaseRepo + verifyCommands/verifyReport/verifyFailCount/verifyFailHint(代码类 WU worktree 与自动验证); mergedAt/mergeCommit/mergeConflict/conflictFiles(自动合并); pmoId(canonical PMO 归因戳, 唯一直读 key; legacy `ownershipProjectId` 同位名仅读取侧兼容); pmoBranch(PMO 分支合并目标); blockedBy/ac(接单依赖与验收标准, 机制只存不解释); progressLog(前序进展, 环形保留最近 5 条); sessionSummary(溢出滚动摘要); defaultTaskAssigneeId(analysis 确认默认执行角色); manualRelease/manualReleaseReason(转人工留痕); analysisTasks/analysisTasksSpawned/analysisTasksSpawnedAt/analysisFog/analysisDestination/autoConfirmedBy/autoConfirmedAt(analysis 派生哨兵集)。
- **鉴权**: 15 条写端点(CRUD/claim/unclaim/review/status/讨论区发消息/编辑消息/opportunities adopt·ignore/resume/close) = requireAuth()+requireNotGuest(); GET 只读保持大门层。review-passed/review-rejected/POST /:id/status 拒绝 authorType=agent(403, A2A §4.4: 验收权只在人; 服务层 transitionStatus 不限 agent 内部合法迁移)。authorType/agentName 是自声明身份(不作凭证, 已知局限)。
- **blockForManualRelease**: AgentInstanceService.terminate unclaim 后经本方法置 blocked 转人工(unassigned->blocked 不在 VALID_TRANSITIONS, 语义方法直写快照 + appendEvent('blocked') + publishStatusChanged; assigneeId/claimedAt 清空, metadata.manualRelease/manualReleaseReason 留痕; 终态 done/closed 不动)。blocked 不在 loop 认领集合内。
- **rebindSourceChannel(from, to)**: 频道删除兜底时 WU 重挂唯一入口, 解析 metadata 按 context.sourceChannelId 字段相等匹配顶层 task WU(替代 raw JSON includes 子串匹配, 杜绝误伤), metadata-only 更新不发 status_changed(appendEvent('updated') + upsertSnapshot 走 update() 惯例)。
