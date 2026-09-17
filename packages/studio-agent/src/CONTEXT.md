# packages/studio-agent/src

### 职责

提供 Agent 执行引擎的核心能力，包括统一执行器（AgentRunner）与 Agent 注册中心（AgentRegistry）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理轻量执行路径，并收集输出与指标。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器（executeLightweight / stop / stopProcessGroup / stopAllProcessGroups），支持流式 JSON 输出；stop() 所有权唯一（runningProcesses 只在此注册）；#178 `stopProcessGroup` = kill(-pid) 杀整进程组（fencing 易主/租约场景，ESRCH 跳过、非 ESRCH 回落单杀）；#179（#66 决议 2）`stopAllProcessGroups` = 优雅关闭时 SIGTERM 杀全部注册进程组并清表（不等 step 落盘，api shutdown 调用）。**#562 删除多 session 循环 `execute()`**，包入口公共面随之收窄 |
| `buildSpawnArgs` | cli-adapter.ts | 纯函数，为指定 provider 构建 CLI spawn 参数（command + args）；#565 起 SpawnParams 增可选 `supportedFlags`（能力探测产出，studio-shared capability-probe），提供时剔除模板 conditionalFlags 中目标 CLI 不认识的 flag，缺省 = fail-open 全量传参（runner-params buildSessionCommand 是消费点） |
| 类型 `Provider`, `SpawnParams`, `SpawnArgs` | cli-adapter.ts | CLI 适配相关类型 |
| 类型 `AgentMetadata`, `JSONSchema` 等 | types.ts | Agent 元数据、JSON Schema 等类型定义 |
| 类型 `AgentTask`, `ExecutionResult`, `ExecutorConfig`, `PrerequisiteCheck`, `RunnerExecutionState` | services/types.ts | 任务、执行结果与执行器配置类型（原 session-manager.ts）；#565 起 ExecutionResult 增可选 `failureClass`（studio-shared failure-classifier 产出，runner-lightweight 失败路径命中已知特征时带出，error 同时加 `[category] guidance` 前缀；未命中行为与现状一致）；`RunnerExecutionState` #562 起自 runner-execution.ts 迁入本文件 |

### 依赖关系

**上游（本目录依赖）**:
- `@dommaker/studio-shared`（核心库：logger, eventBus, FileStore, parseStreamEvents, resolveProviderDefinition, buildArgsFromTemplate 等）
- `@dommaker/studio-shared/node`（execSh, resolveSessionId, readSessionIdFile, resolveVpsWorkspace）
- `@dommaker/studio-shared/harness`（parseSessionMetrics、extractProviderUsage）
- `uuid`（生成唯一标识）
- `ajv`、`ajv-formats`（JSON Schema 校验）

**下游（依赖本目录的模块）**:
- `apps/api` 的 daemon 层（session-manager.ts）和 modules/agents、modules/discord 等路由/循环模块

### 注意事项

- **零行为变更原则（已终结）**：runner-* 拆分（runner-params / runner-output / runner-lightweight）全程保持公共 API 不变；2026-08 删除死去的 AgentExecutor 双胞胎（session-manager.ts，821 行）；2026-09（#562）删除另一条无调用方路径（多 session 循环），**该原则自此不再适用——AgentRunner 只剩一个执行方法**。历史唯一行为变化：Discord `/studio stop` 之前调 `agentExecutor.stop`（独立空 map，静默 no-op），现指向 `agentRunner.stop`，停止真正生效。
- **类型归属**：`ExecutorConfig`/`AgentTask`/`ExecutionResult`/`PrerequisiteCheck`/`RunnerExecutionState` 定义在 services/types.ts，由 agent-runner.ts 门面 re-export；外部经 `@dommaker/studio-agent` 包入口导入不变。
- **worktree 模块分工（#562 校准）**：worktree-resolver.ts 只保留 git/依赖生命周期（resolveWorkspace / createWorktree / ensureWuWorktree / ensureDeps / propagateHarnessConfig）。曾承载「agent 被告知的内容」文件桥的 scaffolding 模块（worktree-scaffolding.ts → runner-briefing.ts，写 REQUIREMENTS.md / CACHE_PREFIX.md / 契约测试）已随多 session 循环删除——轻量路径的 prompt 全部由调用方（agent-loop）给出，本包只落 `.daemon/prompt.md`。
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-lightweight）不得反向依赖 agent-runner.ts 的类；状态通过 `RunnerExecutionState` 接口传入，公共类型一律从 types.ts 导入。
- **事件统一写口（#361，2026-08-27）**：output-capture 的 5 个发射点（recordSessionMetrics/emitSessionStart/emitSessionEnd/emitToolCall/emitFileChange）全部改走 `@dommaker/studio-shared` 的 `writeStudioEvent`（StudioEvent envelope 形态），删除自抄 appendJsonl 的模块级直连路径——此前在模块加载期固化 `studioPath('logs')`，绕过 STUDIO_EVENTS_FILE 测试隔离（vitest 下 runner 事件落生产 logs）。metrics 等扁平字段并入 payload。`ProcessSessionOutputContext` 增 `sessionExtras`：session:end 与 session:start 携带同一份 workUnitId/transcriptPath（修成功/失败双 payload 形态）。测试注意：写口内部 FileStore/logger 是共享包相对导入，包级 vi.mock 拦不到，断言走 STUDIO_EVENTS_FILE tmp 隔离文件读盘。
- **RKB 匹配核心在 studio-shared（#361）**：错误匹配段（regex 失败回退子串、成熟度闸门、hint 格式化）住 `studio-shared/resolutions.ts`，本包不持有实现。#587 摘除本目录那份薄调用后，唯一生产消费方是 apps/api `knowledge/resolution.service.ts`。
- **轻量单 session 是唯一执行路径（#562 后）**：多 session 循环（自动 re-spawn、卡死检测、`.progress.json` 完成判定）整体删除，生产从建单到执行只有 agent-loop 的 step 状态机这一条链。原轻量路径"跳过 SDD 解析 / REQUIREMENTS.md / contract tests / Iron Laws / 依赖缓存"的对照说明随之失效——那些能力不再存在，不再是"轻量 vs 完整"的差别。**#171（#54 决议 A1）**：runner-lightweight 的 execSh 调用恒开 `killProcessGroup`（杀步 = 杀进程组，#68 实测 SIGTERM 杀不死孙进程），并按 AgentTask `silenceWarnMs/silenceKillMs/onSilenceWarn` 透传静默看门狗（判据 = 距最后一次输出间隔；agent-loop 配 300s warn / 600s kill + 1800s 墙钟兜底）。
- **hooks 层收缩的连带（#562）**：studio 侧业务 hook 管线（注册表 + 按名直调判定）在 studio 零生产执行，已按 `docs/adr/2026-09-17-hooks-layer-shrink.md` 删除；本包不再有 `@dommaker/studio-shared/harness/hooks` 依赖。约束进本包的路径只剩两条：**文件级**（propagateHarnessConfig 复制 CLAUDE.md/AGENTS.md + provider-hooks 写执法配置）与**事后验收**（agent-loop completion-gates）。
- **runner-output spawn 尾部管线（Wave-4 抽取）**：`processSessionOutput(stdout, ctx)` 写 .agent.log → stream-json 解析（extractResult/extractUsage）→ tool:call/file:change 事件 → recordSessionMetrics → session:end。差异经 ctx 传入（agentRole/stage/sessionCount/isFirstSession/promptSize/sessionMs）；isError 告警与分支保留在调用方。**#134：ctx 增 `provider`，非 claude provider 的 streamUsage 改走 `extractProviderUsage`（opencode/codex 事件形态 extractUsage 吃不下），claude/缺省行为不变。**本文件现只剩这一条管线：曾同住的两个多 session 循环配套 helper 已在 #587 摘除（停滞判定改由 agent-loop 的静默看门狗承担，见上条）。
- **执行目录解析（#481，2026-09-11 重排）**：worktree-resolver `resolveWorkspace` 三级链 = ① `task.parameters.workspaceRoot`（归属链直接路径）→ ② `hasWorktree=true` 建专属 git worktree（代码类，绝不退回共享目录）→ ③ 无归属落**显式配置的共享工作目录**（`REPO_DIR`，执行时现场读 = 单一来源，只读类任务能读到代码），未配置/不存在落隔离 scratch（`studioPath('scratch')/<executionId>`，绝不猜真实仓）。原 Priority 2「读本机 VPS workspace 记录 root」已删——那条记录的 root 是服务器首次启动时从 REPO_DIR 抄入的一次性抄件（改配置不生效、启动顺序决定生效方），远程节点方向判死后退出执行面。配套 `ensureDeps` 前置条件：目录内既无 lockfile 又无 package.json 即判定非项目检出直接返回（否则拿 repoDir 的 lockfile 把 node_modules 硬链进空 scratch）。测试：`__tests__/worktree-resolver.test.ts`（含「无归属不在 repoDir 建 worktree」防回归锚点）。
- **provider-hooks（#147 步内前置拦截层，2026-08-15；#154 改指 harness shim）**：`services/provider-hooks.ts` = per-provider 执法配置生成器，由 propagateHarnessConfig 调用（幂等）。claude 走 `.claude/settings.json` permissions.deny（--print 下 hook 不触发、deny 实测生效）；codex 走项目级 `.codex/hooks.json` PreToolUse；kimi 走 `KIMI_CODE_HOME` per-worktree 隔离 + config.toml [[hooks]]。codex/kimi 的 hook 统一指向 `@dommaker/harness` 包内 `dist/pretool-use-hook.js`（#154：harness 包出厂 shim，studio-agent 不再生成脚本；旧版 `<worktree>/.studio/command-gate-hook.js` 由 removeLegacyHookScript 自愈清理，kimi 旧配置按 fragment 全串匹配重写迁移）。buildSessionEnv 按 provider=kimi 且 home 已生成时注入 KIMI_CODE_HOME（runner-lightweight 传 worktree）。codex spawn 模板的 trust 门 bypass flag 见本文 `packages/studio-shared` 锚点。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
