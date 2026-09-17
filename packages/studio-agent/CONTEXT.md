# packages/studio-agent

> 最后更新: 2026-09-17
> Agent 执行器 — 轻量单 session 模型 + git worktree 隔离 + harness 配置传递

### 职责

Sub-agent 的完整生命周期管理：创建隔离 worktree → 传播 harness 配置 → spawn provider CLI（单 session）→ stream-json 解析与事件发射。完成判定/状态机不在本包，由 apps/api `modules/agents/loop`（agent-loop + step-guards）承担。

### 核心导出

| 导出 | 说明 |
|------|------|
| `AgentRunner` | 统一执行器：轻量单 session（`executeLightweight`）+ stop/stopProcessGroup/stopAllProcessGroups。**#562 后本类只有一个执行方法**——多 session 循环 `execute()` 无生产调用方，已删除（公共 API 面收窄） |
| `agentRunner` | 单例实例；stop() 所有权唯一在此（runningProcesses 只在本类注册，Discord /studio stop 与 monitor-probes 都调它） |

> 2026-08：旧 `AgentExecutor`/`agentExecutor`（services/session-manager.ts）为 runner-* 拆分前的死代码双胞胎，无生产调用方，已删除；`AgentTask`/`ExecutionResult` 等类型移至 `src/services/types.ts`。
> 2026-08：`AgentCompleter`/`agentCompleter`（services/agent-completer.ts，229 行）整模块零引用，已删除；`AgentConfig`/`AgentCapabilities` 等无人消费的类型导出同步移除（apps 各自本地重定义同名 interface，未从包导入）。
> 2026-09（#562）：死执行路径整簇删除——`services/runner-execution.ts`（`executeSessionLoop`）+ `services/runner-briefing.ts`（REQUIREMENTS.md / CACHE_PREFIX.md / 契约测试文件桥，唯一调用方就是 session loop）+ `runner-params.ts` 的 loop 专属 prompt 构建。生产全部经 `LocalExecutor → executeLightweight`（apps/api loop/executor.ts），session loop 自 runner-* 拆分起再无调用方。判据见 `docs/adr/2026-09-17-hooks-layer-shrink.md`。

### 执行模型

#### 轻量单 session（唯一路径）

不信任 CLI exit code，但也不 re-spawn：一次 spawn 定胜负，成败判定交给上层 agent-loop。

```
executeLightweight(task):
  resolveWorkspace（worktree 复用/新建）→ checkPrerequisites
  → propagateHarnessConfig（CLAUDE.md/AGENTS.md + provider 执法配置）
  → buildAugmentedPrompt(task.prompt, knowledgeContext) → 落 .daemon/prompt.md
  → buildSessionCommand + buildSessionEnv → spawn 一次（stream-json，可杀进程组/静默看门狗）
  → processSessionOutput（写 .agent.log → 解析 → session:start/end 事件 + usage）
```

调用方给全量 prompt，本包不再自行构建（旧 loop 的续接 prompt、卡死重投、strategy hints 随路径一并删除）。

#### Worktree 文件布局

```
worktree/
  .daemon/prompt.md      ← 本次 spawn 的完整 prompt
  .agent.log             ← CLI 输出日志
  .progress.json         ← 进度快照（agent 自写，格式见下）
  .review-report.json    ← 审查报告
  src/                   ← 代码变更
```

> #562 前此处还列 `REQUIREMENTS.md`（AC + 约束文件桥）与根级 `.prompt.md`：前者由已删除的 runner-briefing 写入、后者是旧 loop 的 prompt 落点，两条路径都不再产生它们。

#### .progress.json 格式

由 skill prompt 指示 agent 自己维护（`apps/api/src/scripts/seed-skills.ts`），读方：`output-capture.ts readProgress()`、discord 进度查询、monitor 停滞判定。executor 侧不再据此判定完成（那是 agent-loop 的 completion-gates 职责）。

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

hook 统一指向 `@dommaker/harness` 包内出厂 shim `dist/pretool-use-hook.js`（require.resolve 解析，#154 起不再生成 worktree 内脚本；stdin JSON → CommandGate.isAllowed → exit 2）。`.codex/`、`.kimi-code/` 已入 `GIT_EXCLUDE_PATTERNS`；`CLAUDE.md`（propagate 复制的薄身）同样在列——不排除会 `?? CLAUDE.md` 恒脏、提交守卫误伤（exclude 只影响未跟踪文件，业务仓真实跟踪 CLAUDE.md 不受影响）；`.studio/` 自 #154 移出 exclude（纯文档正本整体进 git）。黑名单规则本身不在此改（harness 仓另议）。已知限制：agent 运行中可改写自己 worktree 内的执法配置（deny-only 执法面边界，worktree 重建时 propagate 幂等自愈）。

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
