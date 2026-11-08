# packages/studio-agent

> 最后更新: 2026-10-26
> Agent 执行器 — 轻量单 session 模型 + git worktree 隔离 + harness 配置传递 + SEC-05 OS/网络/身份边界

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
> 2026-09（#587）：#562 删完之后的剩余死面摘除——loop 遗留的 session flag / `--add-dir` 构建 helper、worktree mtime 停滞探测、RKB 解法查询薄包装、Analyst 产出上下文类型、`parameters` 上无人设置的 claude flag 拼接通道，以及 studio-shared 侧无人调用的约束 prompt 路由模块（渲染正本当时在 harness `renderConstraintsByTrigger`，该 API 已随 harness 1.10.0/ADR-0029 删除）。裁定的两处边界见 `docs/plans/2026-09-587-clear-562-orphans.md`。

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

**会话续接只有一个通道**：`task.parameters.sessionId`（+ `sessionResume: true` 表示续用已存在会话），经 cli-adapter 按 provider 换语法——#639 起一律按 CLI 真实会话号 id 形态点名续用（claude `--session-id <id>` 新建 / `--resume <id>` 续用；kimi、opencode `--session <id>`；codex `exec resume <id>`；cwd 维度 `--continue`/`exec resume --last` 已撤除，实证记录见 `src/cli-adapter.ts` 文件头）。本包不接收任何 provider 专属 flag 原文——旧 daemon 链路那种「调用方直接给一串 claude 参数」的通道已随其生产者删除（#587），活路径的停滞判定也不在此（agent-loop 传 `silenceKillMs`，判据 = 距最后一次输出间隔）。

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

**Git 参数边界（SEC-03，2026-10-26）**：`worktree-resolver.ts` 的 Git 调用统一经 `execFile`/`execFileSync` 参数数组，不再拼 `execSh` 字符串；分支先过零子进程严格形状预检，再执行 `git check-ref-format --branch`，危险输入在任何 worktree/branch 副作用前失败。`ensureBranchExists` 只把明确 unknown revision 视为不存在并建支；超时、权限、仓库损坏等错误保留 stderr 诊断并原样上抛。正常 worktree 创建、复用与失败清理由既有 mock 测试和真实临时仓测试覆盖。SEC-04 起 API agent-loop 调用这些原语时经统一 `withExecutionRepo` 持固定 repo fd，LocalExecutor 在实际 CLI 全周期持工作目录 fd；capability 不进 metadata，正常 worktree 创建/复用行为不变。

**#701 多仓 PMO 集成交合隔离**：`ensurePmoIntegrationWorktree` 以 `projectId + git common-dir 哈希 + leg branch 哈希` 键控，capability/fd 路径不进入身份；复用前同时核验真实 common dir 与 checkout HEAD，身份不明或不符直接抛错，不自动删除/迁移旧现场。多仓、同仓多腿及稳定复用由 mock 与真实临时仓测试共同覆盖（`worktree-resolver.ts`、`worktree-resolver-pmo{,-integration}.test.ts`）。

#### .progress.json 格式

由 skill prompt 指示 agent 自己维护（内置 skill 正本随 `@dommaker/studio-skill` 包分发，首启经 bootstrap `seedBuiltinSkillsStep` 落盘），读方：`output-capture.ts readProgress()`、discord 进度查询、monitor 停滞判定。executor 侧不再据此判定完成（那是 agent-loop 的 completion-gates 职责）。

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

#### Spawn env 与执行边界（SEC-05，2026-10-26）

`buildSessionEnv` 改为 `buildProviderSpawnEnv` 显式 allowlist：只带通用运行变量和当前 CLI/provider 的凭证、base URL/model；Deploy/JWT/Admin/通知等控制面秘密永不继承，`parameters.extraEnv` 也只接受固定非敏感执行元数据。`execSh` 同时传 `inheritProcessEnv:false`，避免底层默认合回完整宿主 env。`IS_SANDBOX=1` 仍只负责 Claude root guard，本身不作为隔离机制。

`runner-lightweight` 每次真实 CLI 执行都经 `prepareAgentSandbox`：Linux root 下 `bwrap` 隔离 mount/PID/network + `setpriv` 降权，uid/gid/groups 均为 65534；worktree 可写采用快照恢复策略（预备时 gid 65534 group 写，dispose/失败恢复原 uid/gid/mode，含 `.git`），系统运行库、当前 provider、真实 harness shim/依赖和必要凭证只读。网络只经 Unix-socket egress broker 的 host+port allowlist；plain HTTP 由 broker 注入 Agent 不可去除的独立来源标记，loopback/Studio callback CONNECT 拒绝。初始化失败回滚身份/server/目录/权限，dispose 幂等。非 Linux 或无法建立独立 OS 身份时直接拒绝 spawn。worktree 内 `bypassPermissions`/hook 配置仍可被 Agent 改写，但不能扩大外层边界。短期单用途凭证能力未被 provider 证实：现有 provider token/OAuth 文件仍可能是长期可重放凭证，不宣称已变成短期凭证。

provider=kimi 且 `<worktree>/.kimi-code/config.toml` 存在时仍注入 `KIMI_CODE_HOME=<worktree>/.kimi-code`；其 credentials/oauth 链接目标由沙箱按当前 provider 只读挂载，不再回退读取整个全局 home。

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
| `@dommaker/harness` | buildConstraintPrompt() + checkBeforeExecution() + CommandGate（#147 前置拦截 hook 脚本引用其 dist）。**另有一条子进程 CLI 调用面**：`services/output-capture.ts` 里 `npx harness constraints --json`（取 constraintHash/constraintSize 进 agent_session 指标），走的是 `constraints` **父级** `--json`——harness 1.11.0 把子命令 `constraints report --json` 换名成 `--json-output` 时父级未动。harness 改 CLI flag 时这是本包唯一 grep 落点。 |
| `@dommaker/studio-shared` | logger |

### 事件

统一经 `@dommaker/studio-shared` 的 `writeStudioEvent` 落盘（StudioEvent envelope，`source: 'agent-executor'`；#361 起单写口，发射点见 `services/output-capture.ts`）。

| 事件 | 发射时机 | payload |
|------|------|------|
| `session:start` | spawn 前 | sessionId / agentId(=executionId) / executionId / sessionCount + extras |
| `session:end` | 成功走 spawn 尾部管线（processSessionOutput）；exec 异常路径由 runner-lightweight 直发 | 同 session:start——#361 起 start/end 携带同一份 extras（workUnitId/transcriptPath，有值才并入），单 payload 形态 |
| `tool:call` | stream-json 解析到 tool_use | tool / input / sessionId / executionId |
| `file:change` | tool_use 可提取文件路径时（随 tool:call 发出） | path / sessionId / executionId |
| `agent_session` | 会话结束记录指标（recordSessionMetrics） | tokens（input/output/cacheRead/cacheWrite）/ costUsd / durationMs / numTurns / modelName / constraintHash / constraintSize 等 |

> 2026-09（#589）：旧表的 `agent.progress`/`agent.heartbeat`/`agent.completed`/`agent.failed` 是 session-loop 时代词表，发射点已随循环消失（#562），全仓零命中，表删除。

### 关键配置

`ExecutorConfig` 只剩两项（`resolveWorkspace` / `checkPrerequisites` 消费）：

| 配置 | 默认值 | 说明 |
|------|------|------|
| `worktreesDir` | `~/worktrees`（env `WORKTREES_DIR` 可覆盖） | worktree 落点 |
| `repoDir` | 自 cwd 向上找 `package.json`，兜底 `~/projects` | 主仓库路径 |

单次 spawn 超时取 `task.timeoutMs ?? 30min`（runner-lightweight 扁平默认），不经 `ExecutorConfig`。

> 2026-09（#589）：`taskTimeoutMinutes`/`sessionTimeoutMinutes` 只写不读，已删除（#587 核实、#593 解除 auditor 文案连带约束）；旧表混入的 studio-shared AgentConfig 字段 `dockerImage`/`heartbeatIntervalMinutes` 与本包无关且全仓零消费方（Docker 化时代残留 env），已同票从 `packages/studio-shared/src/config/index.ts` 裁掉。
