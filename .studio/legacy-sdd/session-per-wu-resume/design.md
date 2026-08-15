---
id: "sdd-1786420000000-session94-design"
slug: "session-per-wu-resume"
title: "会话号 per-WU 化与续用降级 — 设计"
status: "done"
version: 1
createdAt: "2026-08-11T03:30:00.000Z"
updatedAt: "2026-08-11T03:30:00.000Z"
---

## 设计

### 1. 新模块 `loop/session-resume.ts`（纯函数，零服务依赖）

```ts
// cwd → claude projects 目录 slug：'/' 与 '.' 均换 '-'
// （生产实测：/root/.claude → -root--claude；下划线保留）
export function claudeCwdSlug(cwd: string): string

export function defaultClaudeProjectsDir(): string  // path.join(os.homedir(), '.claude', 'projects')（code-review 后删未用 home 参数）

export function claudeSessionFileExists(sessionId: string, cwd: string, projectsDir?: string): boolean

// 续用判定：只信档案 sessionId。
//  - 无 sessionId → false
//  - 非 claude（kimi/codex/opencode 为 cwd 维度续用，无 id 对应文件可查）→ true
//  - claude 且 cwd 未知（workspaceRoot 解析不出）→ true（无法校验，交给 CLI 错误 + 降级兜底）
//  - claude 且 cwd 已知 → 会话文件存在性
export function shouldResumeSession(provider: string, sessionId: string | undefined | null, cwd: string | null): boolean

// 续用失败错误识别（降级触发条件）
export const RESUME_FAILURE_RE = /no conversation found|session not found/i
```

测试注入点：`os.homedir()` 在 POSIX 优先读 `process.env.HOME`——测试 `vi.stubEnv('HOME', tmpdir)` 后在 tmp 下造 `.claude/projects/<slug>/<id>.jsonl`，无需 mock 文件系统。

### 2. agent-loop.ts 改造

- 续用判定从 :559-561 **移到 worktree 解析之后**（:668 之后，此时 `workspaceRoot` 即本步真实 cwd 或 null）：
  `resumeSessionId = shouldResumeSession(taskProvider, metadata.sessionId, workspaceRoot) ? metadata.sessionId : null`。
  注：`taskProvider` 的取值行（:671）需相应前移。
- 新建分支（sessionCount 上限检查、签发 UUID、写 metadataUpdates）逻辑不变；**删除** :584-587 的 instance 槽位写入。
- `metadataUpdates.lastSessionResumed`：新建分支 = false；续用分支 = true。
- **降级重试**：success===false 分支（:747）内，若 `resumeSessionId && RESUME_FAILURE_RE.test(detail)`：
  - 换发 `fallbackSessionId = randomUUID()`；task.parameters 改：`sessionId = taskProvider==='claude' ? fallbackId : undefined`，删 `sessionResume`；
  - metadataUpdates：`sessionId=fallbackId`、`sessionCount=sessionsUsed+1`、`lastSessionResumed=false`；
  - 重试 `executor.execute(task)` 一次；成功 → 走正常成功路径（事件 sessionResumed=false）；失败 → 既有 failed 返回（`resetUnestablishedSession` 清掉未落盘的新会话簿记）。
  - catch 分支（:861，spawn 异常）**不**降级。
- execution_step 事件调用点（:795）补 `sessionResumed: <最终实际>`。
- `resetUnestablishedSession`（:985）：删 instance 槽位清除（:986-989），保留 metadata 增量删除 + 补 `delete metadataUpdates.lastSessionResumed`；JSDoc 更新。
- `checkSessionTruncation`（:996，死代码，整体删除归 #96）：仅移除 sessionId 相关三行（:1008-1010），保留 token 超限日志。
- B5 超限文案（:575）：去掉「回复会重置会话预算」，改为「请人工评估后回复任意内容继续，或直接关闭任务」。
- `RuntimeStateData.sessionId` 类型字段与实例创建处 `sessionId: null`（:190）保留（state.json 落盘兼容），仅不再读写。

### 3. 事件与 metadata 标记

- `execution-step-events.ts`：`ExecutionStepEventPayload` 与 `BuildExecutionStepEventArgs` 加 `sessionResumed?: boolean`；`buildExecutionStepEvent` 透传（`...(args.sessionResumed !== undefined ? { sessionResumed: args.sessionResumed } : {})`）。
- `workunit.types.ts`：`lastSessionResumed?: boolean; // #94: 本步会话续用(true)/新建(false) 标记（内部状态，不上频道）`。
- `wu-metadata.ts` clearSessionBookkeeping：加 `delete cleaned.lastSessionResumed;`，注释 12→13 字段。

### 4. 废除复活清零

- `waiting-input.ts:70` 删 `sessionCount: 0` 行及其注释。复活后下一步凭 metadata.sessionId 优先续用旧会话（spec F「复活优先续用旧会话」），不再靠清零预算放行。

### 5. 频道侧

零改动。execution_step 不进频道为 execution-step-events.ts 头注既有约束；频道进度贴只发 `result.summary`，标记不进 summary。

### 风险与边界

- 降级重试会多烧一次 CLI 调用——仅匹配「会话不存在」错误时触发，超时/业务失败不触发，烧量有界（每步至多一次）。
- 降级绕过 MAX_SESSIONS_PER_WU 上限一次（resume 分支不查上限）：可接受，预算防线针对「反复从零重开」，降级是单次自愈。
- 旧生产数据：metadata.sessionId 存在但对应 claude 文件可能已被清理 → 自动走新建分支，无迁移成本。
