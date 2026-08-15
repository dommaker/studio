---
id: "sdd-1786420000000-session94"
slug: "session-per-wu-resume"
title: "会话号 per-WU 化与续用降级"
status: "done"
tier: "standard"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["agents", "agent-loop", "session", "workunit"]
createdAt: "2026-08-11T03:30:00.000Z"
updatedAt: "2026-08-11T03:30:00.000Z"
---

## 会话号 per-WU 化与续用降级（issue #94）

会话号只信任务档案 metadata.sessionId，废弃实例单槽位（一改同时治好并行互踩与重启孤儿化）。档案有号且 CLI 会话文件在 → 尝试续用；续用失败自动降级开新会话并落 resumed 标记（不上频道、不报错卡死）。废除复活时 sessionCount=0 清零的旧逻辑。execution_step 事件与 metadata 补「本步续用还是新建」布尔标记；频道进度贴不显示。

## AC Groups

### ac-per-wu-session

#### 验收标准
- [ ] 续用判定只读 `metadata.sessionId`（不再读 `instance.sessionId`）；claude provider 额外要求会话文件 `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` 存在（slug = cwd 的 `/`、`.` → `-`），cwd 取本步最终 workspaceRoot
- [ ] 并行 WU 同实例不互踩会话：同实例交替执行两个各有 sessionId 的 WU，各自续用互不干扰
- [ ] 服务重启后在途 WU 可续用：loop 无 instance 槽位（新实例 sessionId=null）时，仅凭 metadata.sessionId + 会话文件即可续用
- [ ] agent-loop 对 `instance.sessionId` 的写/清全部移除（新建分支、resetUnestablishedSession、checkSessionTruncation）

### ac-resume-fallback

#### 验收标准
- [ ] 续用步失败且错误匹配「会话不存在」（/no conversation found|session not found/i）→ 自动换发新 sessionId 重试一次（claude 传 --session-id、不带 sessionResume），再失败走既有 failed 路径
- [ ] 降级重试成功：metadata.sessionId 换新、sessionCount+1、lastSessionResumed=false
- [ ] 非续用类错误（如 120s 超时、spawn 异常）不触发降级重试
- [ ] 档案有 sessionId 但会话文件不在（claude）→ 直接走新建分支（sessionCount 递增、受 MAX_SESSIONS_PER_WU 约束），不发 --resume

### ac-revive-no-reset

#### 验收标准
- [ ] `resumeWaitingWorkUnit` 不再清零 sessionCount（waiting-input.ts:70 删除）
- [ ] B5 会话超限 need_input 文案去掉「回复会重置会话预算」表述

### ac-resumed-marker

#### 验收标准
- [ ] metadata 新增 `lastSessionResumed?: boolean`（本步续用 true / 新建 false），并加入 `clearSessionBookkeeping` 权威清单
- [ ] execution_step 事件 payload 新增 `sessionResumed?: boolean`，buildExecutionStepEvent 透传
- [ ] 频道进度贴不显示该内部状态（execution_step 不进频道为既有约束，频道侧零改动）

#### 涉及文件
- apps/api/src/modules/agents/loop/agent-loop.ts
- apps/api/src/modules/agents/loop/session-resume.ts（新建）
- apps/api/src/modules/agents/loop/execution-step-events.ts
- apps/api/src/modules/workunit/workunit.types.ts
- apps/api/src/modules/workunit/wu-metadata.ts
- apps/api/src/modules/workunit/waiting-input.ts
- apps/api/src/modules/agents/__tests__/agent-loop-session-resume.test.ts
- apps/api/src/modules/agents/loop/__tests__/session-resume.test.ts（新建）
- apps/api/src/modules/agents/__tests__/execution-step-events.test.ts
- apps/api/src/modules/workunit/__tests__/block-reason.test.ts

#### 依赖

无（Blocked by: None）

## Files

- apps/api/src/modules/agents/loop/agent-loop.ts
- apps/api/src/modules/agents/loop/session-resume.ts
- apps/api/src/modules/agents/loop/execution-step-events.ts
- apps/api/src/modules/workunit/workunit.types.ts
- apps/api/src/modules/workunit/wu-metadata.ts
- apps/api/src/modules/workunit/waiting-input.ts
