# workunit

> 此文件描述 apps/api/src/modules/workunit 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/workunit/CONTEXT.md

## 职责

WorkUnit 核心域（AS-025 §3.28c-1, §5.16）：任务单元的 CRUD、认领（Claim）与状态机；F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。

## 核心导出

- `workunit.service.ts` — WorkUnit Service：CRUD + Claim + 状态机，`create()` 发布 `workunit.created` 事件；claim 进入 active 时按 type 写入 `timeoutAt`（task/bug/feature 60min，review/analysis 30min，metadata.timeoutAt 显式值优先）
- `workunit.routes.ts` — WorkUnit API 路由
- `waiting-input.ts` — F5 双向沟通：NEED_INPUT 挂起 WorkUnit 的恢复与超时提醒；B3a：waitingReason='ownership' 的挂起按回复解析工程归属（project-discovery 唯一命中 → 绑定 metadata.workspaceRoot + 写回 Requirement.projectId + 置回 unassigned（保留 assigneeId=profile id，待指名 loop 认领；此类 WU 从未被认领，置 active 会对所有 loop 不可见而卡死）；多候选/无命中 → 继续等待列候选）；导出 `postStudioSystemMessage`（Studio 系统消息统一形态）
- `timeout-release.ts` — workunit-timeout-scan handler：执行超时 WU 释放回 unassigned（记 metadata.timeoutReleasedAt/timeoutReleaseCount + 频道系统消息），≥3 次转 blocked
- `delegation-gate.ts` — A2A 委派闸门（§4.1/§4.2，纯代码零 LLM）：成员/自派生/深度(P1=1)/宽度3/树8/环/重复委派校验，预算留桩（TODO §4.3 P2）
- `merge-on-review-pass.ts` — B3b-ii 评审通过后自动合并（决策 D1/D3 后半）：reviewPassed 收口触发（best-effort，不阻断 done 迁移），task/<wuId> --no-ff 合并回 base 分支 → 冲突则 rebase 重试一次 → 仍冲突清理现场、取冲突文件清单、频道 Studio 系统消息转人工并置 blocked（metadata.mergeConflict/conflictFiles）；成功则移除 worktree、删 task 分支、记 metadata.mergedAt/mergeCommit 并发频道通知；mergedAt 为防重哨兵，无 worktree 落档的 WU 直接旁路

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、projects（project-discovery 候选搜索）、requirements（Requirement projectId 写回）、pmo（projectService 查/建 gitRepo 锚点项目）
- 下游：agents（AgentLoop 认领执行）、requirements（状态汇总）、channels（@mention 派发）、triggers（CREATE 动作）

## 注意事项

- **assigneeId 双语义（§1.2-b，2026-07-28 全仓核对）**：同一字段两种含义按状态切换——**unassigned 时 = 被指名的 profile.id**（@mention 派发、A2A 委派、B3a 归属绑定复活；可见性由 AgentLoop.observe 的 unassigned 过滤保证：assigneeId 非空仅该 profile 的 loop 可见，null 走频道 members）；**认领后 = 认领方 loop 的 instance.id**（file-store.claimWorkUnit 只校验 status==='unassigned'，不校验既有 assigneeId，认领即改写；myActive/续跑按 instance.id 查询）。推论：active + assigneeId=profile.id 是卡死态（续跑查询与认领过滤都看不到）——channels/convert-to-task.service.ts 曾如此（UI 传 profile.id 直接建 active），L1（2026-07-28）已修为统一建 unassigned。claim 的锁是 flock **悲观互斥锁**（mkdir 原子目录跨进程互斥），非乐观锁（无版本号/读后再验）；token 归因按双语义解析（instance→state.roleId 反查，本身就是 profile.id 则直接命中）
- 状态变更发布 `workunit.status_changed` 事件，requirements/rollup 据此汇总 REQ 状态
- NEED_INPUT 挂起后由人在频道线程回复触发续跑
- B3a（决策 D2）：WU metadata 增 workspaceRoot / ownershipSource / ownershipProjectId / waitingReason 字段承载工程归属；agent-loop 执行根目录解析 metadata.workspaceRoot 优先于 workspaceId 记录
- B3b-i（决策 D1/D3 前半）：WU metadata 增 worktreePath/worktreeBranch/worktreeBaseBranch/worktreeBaseRepo（代码类 WU 专属 worktree 落档，review 子 WU 经 `...parentMeta` 拷贝天然继承）与 verifyCommands/verifyReport/verifyFailCount/verifyFailHint（自动验证）；覆盖命令也可放在 workspace 记录的 verifyCommands 字段
- B3b-ii（决策 D1/D3 后半）：WU metadata 增 mergedAt/mergeCommit/mergeConflict/conflictFiles；reviewPassed 收口触发自动合并（merge-on-review-pass.ts，git 全走 execSh，冲突转人工置 blocked 走 `markMergeConflict` 直写快照——done→blocked 同 reviewRejected 先例绕过 VALID_TRANSITIONS）
- review-passed/review-rejected 拒绝 authorType=agent 的调用（403，A2A §4.4：验收权只在人；UI/人类调用不发送 authorType 或发送 'human'）
- **鉴权（2026-07-24 收紧）**：11 条写端点（CRUD/claim/unclaim/review/status/讨论区发消息/编辑消息）= `requireAuth()+requireNotGuest()`；GET 只读保持大门层。注意 authorType/agentName 仍是自声明身份（不作凭证，已知局限）

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `39b6af5f`: channels): L1 convert-to-task 人工指派卡死修复（指派统一建 unassigned 指名）
- ✅ `a02f05cb`: agents): SessionSummary stale 标记同步清除旧警告块，修复 CONTEXT.md 重复叠加
- ✅ `faa07b29`: agent): repoDir CLAUDE.md 仅同仓传播 + exclude 补 .harness/（验收修复 C，P2 续）
- ✅ `7e36fd19`: agent): 验收 e2e 抓出两修真链漏洞 — 提交守卫读合并视图 + 合并前数据防丢闸
- ✅ 2026-07-28: 验收修复 B — merge-on-review-pass 加数据防丢闸：worktree 有未提交改动（或 git status 调用失败）时绝不合并/强删（原流程 `git merge` 对无提交分支 "Already up to date" 假成功后 `worktree remove --force` 静默丢弃未提交工作），转 blocked + 频道列清单转人工，worktree/分支保留；补测试 2 例
- ✅ 2026-07-28: P5d assigneeId 语义全仓核对 — 唯一两处注释/行为不符已修：①claim 注释 "optimistic lock" 误名（实为 flock 悲观互斥锁，workunit.service/workunit.routes 三处）②token-usage 注释把 assigneeId 绝对化为实例 id（与 §1.2-b 双语义矛盾），并把树报表未认领指名节点的归因补上 profile.id 直查（原恒 null，补测试 1 例）；assigneeId 双语义写入注意事项；其余条目（waiting-input/agent-loop/delegation-gate/timeout-release/file-store/message-routing）核对均一致
- ✅ `d7bd1e85`: workunit): ownership 归属绑定后 WU 置回 unassigned，修复永久卡死
- ✅ `6f263685`: p0): 信任链六项修复 — 失败误判/超时机制/reviewReport回传/告警出口/日志隔离/traceId
- ✅ `782ac0a9`: 路由层防御纵深 — 写操作端点加 requireAuth+requireNotGuest/requireAdmin
- ✅ `f588061f`: spec4-post-p3): Prisma removal test cleanup — 19 files
- ✅ `008912d6`: db-removal): complete Spec 1 AC-2/3/6 — dead table cleanup
- ✅ `c3b1aab8`: channel-an): resolve 7 code review warnings
- ✅ 2026-07-28: 修 ownership resume 卡死 — B3a 归属绑定后 WU 由置 active 改为置回 unassigned（保留 assigneeId=profile id）：此类 WU 创建即挂起从未被认领，active + assigneeId=profileId 时 loop 续跑查询（myActive 按 instance.id）与认领过滤（要求 unassigned）都看不到它，永久卡死；回 unassigned 后指名 profile 的 loop 在 unassigned 过滤中认领（claim 改写 assigneeId 为 instance.id）。agent 提问型 NEED_INPUT 的 resume（WU 已认领过）仍回 active 不变。同时修正 claim doc 注释：file-store.claimWorkUnit 只校验 status==='unassigned'，不校验 assigneeId 且认领即改写
- ✅ 2026-07-27: B3b-ii 评审通过后自动合并（决策 D1/D3 后半）— 新增 merge-on-review-pass.ts：reviewPassed 收口 best-effort 触发 task/<wuId> --no-ff 合并回 base 分支（冲突 → abort + worktree rebase 重试一次 → 仍冲突清理现场取冲突文件清单，频道 Studio 消息转人工并置 blocked；成功 → worktree remove + branch -d + metadata.mergedAt/mergeCommit + 频道通知）；mergedAt 防重，无 worktree 落档旁路；workunit.service 增 markMergeConflict（直写快照 done→blocked）与 4 个 metadata 字段
- ✅ 2026-07-27: B3b-i — WorkUnitMetadata 新增 worktreePath/worktreeBranch/worktreeBaseBranch/worktreeBaseRepo（每 WU 专属 worktree 落档）与 verifyCommands/verifyReport/verifyFailCount/verifyFailHint（COMPLETE 前自动验证：覆盖命令、全绿摘要、失败计数与提示）
- ✅ 2026-07-27: B3a 工程归属链（决策 D2）— waiting-input 增 ownership 挂起分支：回复按 project-discovery 候选解析，唯一命中绑定 metadata.workspaceRoot 并复活、写回 Requirement.projectId（gitRepo 相同的既有 PMO 项目复用，否则新建锚点项目）；多候选/无命中继续等待并发 Studio 消息列候选；抽出 postStudioSystemMessage 统一系统消息形态（message-routing 复用）
- ✅ 2026-07-27: P0 修复 5/6 — delegation-gate 的 studio-events.jsonl 走 studio-log-path 测试隔离（原测试直接写并 rm 真实 ~/.studio/logs/studio-events.jsonl，有删生产数据风险）；WorkUnitMetadata 新增 traceId 字段（P0 修复 6）
- ✅ 2026-07-27: P0 WU 超时机制从零接上 — claim 写 timeoutAt；workunit-timeout 触发器 UPDATE→EXECUTE（workunit-timeout-scan，timeout-release.ts），UPDATE 查询支持 lt/gt/lte/gte 与 '$now' 执行时刻求值
- ✅ 2026-07-24: API 鉴权收紧 — 写端点收 requireAuth+requireNotGuest（WU 派单/状态机此前无角色层）
