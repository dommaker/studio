# workunit

> 此文件描述 apps/api/src/modules/workunit 目录的职责和上下文

## 职责

WorkUnit 核心域（AS-025 §3.28c-1, §5.16）：任务单元的 CRUD、认领（Claim）与状态机；F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。

## 核心导出

- `workunit.service.ts` — WorkUnit Service：CRUD + Claim + 状态机，`create()` 发布 `workunit.created` 事件；claim 进入 active 时按 type 写入 `timeoutAt`（task/bug/feature 60min，review/analysis 30min，metadata.timeoutAt 显式值优先）
- `workunit.routes.ts` — WorkUnit API 路由
- `waiting-input.ts` — F5 双向沟通：NEED_INPUT 挂起 WorkUnit 的恢复与超时提醒；B3a：waitingReason='ownership' 的挂起按回复解析工程归属（project-discovery 唯一命中 → 绑定 metadata.workspaceRoot + 写回 Requirement.projectId；多候选/无命中 → 继续等待列候选）；导出 `postStudioSystemMessage`（Studio 系统消息统一形态）
- `timeout-release.ts` — workunit-timeout-scan handler：执行超时 WU 释放回 unassigned（记 metadata.timeoutReleasedAt/timeoutReleaseCount + 频道系统消息），≥3 次转 blocked
- `delegation-gate.ts` — A2A 委派闸门（§4.1/§4.2，纯代码零 LLM）：成员/自派生/深度(P1=1)/宽度3/树8/环/重复委派校验，预算留桩（TODO §4.3 P2）

## 依赖关系

- 上游：`@dommaker/studio-shared`（eventBus、FileStore）、projects（project-discovery 候选搜索）、requirements（Requirement projectId 写回）、pmo（projectService 查/建 gitRepo 锚点项目）
- 下游：agents（AgentLoop 认领执行）、requirements（状态汇总）、channels（@mention 派发）、triggers（CREATE 动作）

## 注意事项

- 状态变更发布 `workunit.status_changed` 事件，requirements/rollup 据此汇总 REQ 状态
- NEED_INPUT 挂起后由人在频道线程回复触发续跑
- B3a（决策 D2）：WU metadata 增 workspaceRoot / ownershipSource / ownershipProjectId / waitingReason 字段承载工程归属；agent-loop 执行根目录解析 metadata.workspaceRoot 优先于 workspaceId 记录
- review-passed/review-rejected 拒绝 authorType=agent 的调用（403，A2A §4.4：验收权只在人；UI/人类调用不发送 authorType 或发送 'human'）
- **鉴权（2026-07-24 收紧）**：11 条写端点（CRUD/claim/unclaim/review/status/讨论区发消息/编辑消息）= `requireAuth()+requireNotGuest()`；GET 只读保持大门层。注意 authorType/agentName 仍是自声明身份（不作凭证，已知局限）

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: B3a 工程归属链（决策 D2）— waiting-input 增 ownership 挂起分支：回复按 project-discovery 候选解析，唯一命中绑定 metadata.workspaceRoot 并复活、写回 Requirement.projectId（gitRepo 相同的既有 PMO 项目复用，否则新建锚点项目）；多候选/无命中继续等待并发 Studio 消息列候选；抽出 postStudioSystemMessage 统一系统消息形态（message-routing 复用）
- ✅ 2026-07-27: P0 修复 5/6 — delegation-gate 的 studio-events.jsonl 走 studio-log-path 测试隔离（原测试直接写并 rm 真实 ~/.studio/logs/studio-events.jsonl，有删生产数据风险）；WorkUnitMetadata 新增 traceId 字段（P0 修复 6）
- ✅ 2026-07-27: P0 WU 超时机制从零接上 — claim 写 timeoutAt；workunit-timeout 触发器 UPDATE→EXECUTE（workunit-timeout-scan，timeout-release.ts），UPDATE 查询支持 lt/gt/lte/gte 与 '$now' 执行时刻求值
- ✅ 2026-07-24: API 鉴权收紧 — 写端点收 requireAuth+requireNotGuest（WU 派单/状态机此前无角色层）
