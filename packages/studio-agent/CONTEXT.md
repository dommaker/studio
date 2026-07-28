# studio-agent CONTEXT.md

> 最后更新: 2026-05-05
> Agent 执行器 — session loop 模型 + git worktree 隔离 + 文件桥上下文传递

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: packages/studio-agent/package.json, packages/studio-agent/CONTEXT.md

## 职责

Sub-agent 的完整生命周期管理：创建隔离 worktree → spawn Claude Code → session loop 监控 → 完成判定。

## 核心导出

| 导出 | 说明 |
|------|------|
| `AgentExecutor` | session loop 执行器（max 5 sessions × 30 min） |
| `agentExecutor` | 单例实例 |
| `AgentCompleter` | 执行完成后的后处理（worktree 清理等） |
| `agentCompleter` | 单例实例 |

## 执行模型

### Session Loop

不信任 Claude Code exit code。改读 `.progress.json` 判断完成：

```
execute(task):
  git worktree add → REQUIREMENTS.md → loop:
    spawn Claude Code → wait (30 min timeout) → read .progress.json
    allComplete=true ∧ testsPass → 成功退出
    allComplete=false → 自动 re-spawn
    session≥5 → 失败，Level 3 告警
```

### Worktree 文件布局

```
worktree/
  REQUIREMENTS.md        ← AC + 约束（session 间不变，文件桥）
  .progress.json         ← 进度快照（session 间唯一变化）
  .review-report.json    ← 审查报告
  .prompt.md             ← 当前 session prompt
  .agent.log             ← Claude Code 输出日志
  src/                   ← 代码变更
```

### .progress.json 格式

```json
{
  "taskId": "xxx",
  "allComplete": false,
  "sessionCount": 2,
  "currentStep": "implement-ac-2",
  "completedSteps": ["ac-1"],
  "testResults": { "passed": 8, "failed": 2, "total": 15 },
  "notes": "working on null check"
}
```

### Session Prompt

- Session 1: 全量 prompt（约束注入 + TDD 指令 + 读 REQUIREMENTS.md）
- Session 2+: 极短续接（"读 REQUIREMENTS.md + .progress.json，继续从 {currentStep}"）

## 依赖

| 依赖 | 说明 |
|------|------|
| `@dommaker/harness` | buildConstraintPrompt() + checkBeforeExecution() |
| `@dommaker/studio-shared` | logger |
| `ioredis` | 事件发布（agent.progress/agent.heartbeat） |

## 事件

| 事件 | 说明 |
|------|------|
| `agent.progress` | 每个 session 开始时发布，含 phase/session/maxSessions |
| `agent.heartbeat` | 每 5 分钟发布，含 runningDuration/currentStep |
| `agent.completed` | 全部完成时发布 |
| `agent.failed` | 会话耗尽时发布 |

## 关键配置

| 配置 | 默认值 | 说明 |
|------|:---:|------|
| `sessionTimeoutMinutes` | 30 | 单次 session 超时 |
| `maxSessions` | 5 | 最大 session 循环次数 |
| `heartbeatIntervalMinutes` | 5 | 心跳间隔 |
| `dockerImage` | claude-code:fast | Claude Code Docker 镜像 |

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `bdf5fd4a`: test): fix 27 CI test failures across 8 files
- ✅ `da1d7696`: ci): governance continue-on-error + fix vitest watch mode
