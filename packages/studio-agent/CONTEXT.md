# packages/studio-agent

> 最后更新: 2026-08-15
> Agent 执行器 — session loop 模型 + git worktree 隔离 + 文件桥上下文传递

### 职责

Sub-agent 的完整生命周期管理：创建隔离 worktree → spawn Claude Code → session loop 监控 → 完成判定。

### 核心导出

| 导出 | 说明 |
|------|------|
| `AgentRunner` | 统一执行器：session loop（execute）+ 轻量单 session（executeLightweight）+ stop |
| `agentRunner` | 单例实例；stop() 所有权唯一在此（runningProcesses 只在本类注册，Discord /studio stop 与 monitor-probes 都调它） |

> 2026-08：旧 `AgentExecutor`/`agentExecutor`（services/session-manager.ts）为 runner-* 拆分前的死代码双胞胎，无生产调用方，已删除；`AgentTask`/`ExecutionResult` 等类型移至 `src/services/types.ts`。
> 2026-08：`AgentCompleter`/`agentCompleter`（services/agent-completer.ts，229 行）整模块零引用，已删除；`AgentConfig`/`AgentCapabilities` 等无人消费的类型导出同步移除（apps 各自本地重定义同名 interface，未从包导入）。

### 执行模型

#### Session Loop

不信任 Claude Code exit code。改读 `.progress.json` 判断完成：

```
execute(task):
  git worktree add → REQUIREMENTS.md → loop:
    spawn Claude Code → wait (30 min timeout) → read .progress.json
    allComplete=true ∧ testsPass → 成功退出
    allComplete=false → 自动 re-spawn
    session≥5 → 失败，Level 3 告警
```

#### Worktree 文件布局

```
worktree/
  REQUIREMENTS.md        ← AC + 约束（session 间不变，文件桥）
  .progress.json         ← 进度快照（session 间唯一变化）
  .review-report.json    ← 审查报告
  .prompt.md             ← 当前 session prompt
  .agent.log             ← Claude Code 输出日志
  src/                   ← 代码变更
```

#### .progress.json 格式

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

#### Session Prompt

- Session 1: 全量 prompt（约束注入 + TDD 指令 + 读 REQUIREMENTS.md）
- Session 2+: 极短续接（"读 REQUIREMENTS.md + .progress.json，继续从 {currentStep}"）

#### Spawn env 约定（2026-07-30）

`buildSessionEnv`（runner-params.ts）在 `process.env` 基础上补 `IS_SANDBOX=1`（host 已设则尊重 host）：cwd 的 `.claude/settings.json` 声明 `bypassPermissions` 时，claude `--resume` 续用会话会自注入 `--dangerously-skip-permissions`，而 root guard（`getuid()===0 && IS_SANDBOX!=="1"`）直接 exit 1 —— root 机器上同 WU 第 2+ step 曾全部秒败（2026-07-29 review WU 三连败实锤 + 最小复现验证）。IS_SANDBOX=1 是 CLI 预留的沙箱声明，不放宽任何权限（settings 本就声明 bypassPermissions）。

`buildSessionEnv` 另按 provider 补 env（#147，2026-08-15）：provider=kimi 且 `<worktree>/.kimi-code/config.toml` 存在时注入 `KIMI_CODE_HOME=<worktree>/.kimi-code`（kimi 多 WU 隔离：per-worktree home 由 provider-hooks 生成，凭证软链复用 host，不动 HOME——PIT-019 教训）。home 未生成（kimi 未装/生成失败）则不注入，回落全局 home。

### 步内前置拦截层（#147，2026-08-15）

`services/provider-hooks.ts` = per-provider 执法配置生成器（#138 §4.3「执法面=写 provider 配置的一方」），由 `propagateHarnessConfig` 每次 worktree 创建时调用，幂等：

| provider | 执法面 | 载体 | 语义 |
|----------|--------|------|------|
| claude | `permissions.deny`（`--print` 下 hook 不触发、deny 已实测生效） | `.claude/settings.json`（幂等合并，保留既有字段） | 3 条静态命令（rm -rf * / git push --force* / git reset --hard*）+ 越界写（`~/.studio/**`、主仓库 repoDir 绝对路径） |
| codex | 原生 PreToolUse hook | `.codex/hooks.json`（项目级，per-worktree） | CommandGate block 级 exit 2 阻断（`exec --json` 生效，需 trust 门 bypass，见下） |
| kimi | 原生 PreToolUse hook | `<worktree>/.kimi-code/config.toml`（host 配置复制 + hook 追加；credentials/oauth 软链复用 host）+ spawn env `KIMI_CODE_HOME` | 同上（`-p` 生效） |

hook 统一指向 `@dommaker/harness` 包内出厂 shim `dist/pretool-use-hook.js`（require.resolve 解析，#154 起不再生成 worktree 内脚本；stdin JSON → CommandGate.isAllowed → exit 2）。`.codex/`、`.kimi-code/` 已入 `GIT_EXCLUDE_PATTERNS`；`.studio/` 自 #154 移出 exclude（纯文档正本整体进 git）。黑名单规则本身不在此改（harness 仓另议）。已知限制：agent 运行中可改写自己 worktree 内的执法配置（deny-only 执法面边界，worktree 重建时 propagate 幂等自愈）。

**codex trust 门（0.147.0 实测，D7）**：非 managed command hook 须先 review+trust 才运行，exec 无人值守下未信任一律静默跳过（trust 按 hook hash 持久化，worktree 路径每 WU 不同，无法预信任）→ codex spawn 模板（studio-shared providers.ts）携带 `--dangerously-bypass-hook-trust`（官方定位：已自行审查 hook 来源的自动化）。本机实证：无 flag 时 SessionStart marker 不跑、有 flag 即跑；PreToolUse exit 2 端到端真拦。

### 依赖

| 依赖 | 说明 |
|------|------|
| `@dommaker/harness` | buildConstraintPrompt() + checkBeforeExecution() + CommandGate（#147 前置拦截 hook 脚本引用其 dist） |
| `@dommaker/studio-shared` | logger |

### 事件

| 事件 | 说明 |
|------|------|
| `agent.progress` | 每个 session 开始时发布，含 phase/session/maxSessions |
| `agent.heartbeat` | 每 5 分钟发布，含 runningDuration/currentStep |
| `agent.completed` | 全部完成时发布 |
| `agent.failed` | 会话耗尽时发布 |

### 关键配置

| 配置 | 默认值 | 说明 |
|------|:---:|------|
| `sessionTimeoutMinutes` | 30 | 单次 session 超时 |
| `maxSessions` | 5 | 最大 session 循环次数 |
| `heartbeatIntervalMinutes` | 5 | 心跳间隔 |
| `dockerImage` | claude-code:fast | Claude Code Docker 镜像 |
