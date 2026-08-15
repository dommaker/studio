# src

> 此文件描述 packages/studio-agent/src 目录的职责和上下文

## 职责

提供 Agent 执行引擎的核心能力，包括统一执行器（AgentRunner）与 Agent 注册中心（AgentRegistry）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器（execute / executeLightweight / stop），支持流式 JSON 输出；stop() 所有权唯一（runningProcesses 只在此注册） |
| `buildSpawnArgs` | cli-adapter.ts | 纯函数，为指定 provider 构建 CLI spawn 参数（command + args） |
| 类型 `Provider`, `SpawnParams`, `SpawnArgs` | cli-adapter.ts | CLI 适配相关类型 |
| 类型 `AgentMetadata`, `JSONSchema` 等 | types.ts | Agent 元数据、JSON Schema 等类型定义 |
| 类型 `AgentTask`, `ExecutionResult`, `ExecutorConfig`, `PrerequisiteCheck` | services/types.ts | 任务、执行结果与执行器配置类型（原 session-manager.ts） |

## 依赖关系

**上游（本目录依赖）**:
- `@dommaker/studio-shared`（核心库：logger, eventBus, FileStore, parseStreamEvents, resolveProviderDefinition, buildArgsFromTemplate 等）
- `@dommaker/studio-shared/node`（execSh, resolveSessionId, readSessionIdFile, resolveVpsWorkspace）
- `@dommaker/studio-shared/harness`（parseSessionMetrics）
- `@dommaker/studio-shared/harness/hooks`（beforeAgentExecute）
- `uuid`（生成唯一标识）
- `ajv`、`ajv-formats`（JSON Schema 校验）

**下游（依赖本目录的模块）**:
- `apps/api` 的 daemon 层（session-manager.ts）和 modules/agents、modules/discord 等路由/循环模块

## 注意事项

- **零行为变更原则（已完成）**：runner-* 拆分（runner-params / runner-output / runner-execution / runner-lightweight）全程保持公共 API 不变；2026-08 删除死去的 AgentExecutor 双胞胎（session-manager.ts，821 行，execute() 为 executeSessionLoop 的重复实现、无生产调用方）完成该重构。唯一行为变化：Discord `/studio stop` 之前调 `agentExecutor.stop`（独立空 map，静默 no-op），现指向 `agentRunner.stop`，停止真正生效。
- **类型归属**：`ExecutorConfig`/`AgentTask`/`ExecutionResult`/`PrerequisiteCheck` 定义在 services/types.ts，由 agent-runner.ts 门面 re-export；外部经 `@dommaker/studio-agent` 包入口导入不变。
- **worktree 拆分明细（2026-08-04）**：scaffolding 写入（writeRequirementsMd/writeContractTests/ensureDeps）位于 worktree-scaffolding.ts，经 worktree-resolver.ts re-export，消费方导入路径不变；prompt 构建与执行前置检查拆为 prompt-builder.ts / prerequisite-checks.ts。
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-execution、runner-lightweight、prompt-builder、prerequisite-checks）不得反向依赖 agent-runner.ts 的类；状态通过 `RunnerExecutionState` 接口传入，公共类型一律从 types.ts 导入。
- **Session 循环与轻量路径**：AgentRunner 提供两套执行路径：多 session 循环（runner-execution.ts）和轻量单 session（runner-lightweight.ts），后者跳过 SDD 解析、REQUIREMENTS.md、contract tests、Iron Laws、依赖缓存等，适用于简单任务。**#171（#54 决议 A1）**：runner-lightweight 的 execSh 调用恒开 `killProcessGroup`（杀步 = 杀进程组，#68 实测 SIGTERM 杀不死孙进程），并按 AgentTask `silenceWarnMs/silenceKillMs/onSilenceWarn` 透传静默看门狗（判据 = 距最后一次输出间隔；agent-loop 配 300s warn / 600s kill + 1800s 墙钟兜底）。
- **runner-briefing（Wave-4 拆分）**：`buildCachePrefix`（CACHE_PREFIX.md）、`writeRequirementsMd`（REQUIREMENTS.md）、`writeContractTests`（__tests__/ 契约测试）从 worktree-resolver 移至 services/runner-briefing.ts——"agent 被告知的内容"的文件桥，与 runner-params.ts 的 buildPrompt 配套（prompt 文本直接引用 REQUIREMENTS.md）。worktree-resolver 现在只保留 git/依赖生命周期（resolveWorkspace / createWorktree / ensureWuWorktree / ensureDeps / propagateHarnessConfig）。唯一调用方是 runner-execution.ts。
- **runner-output spawn 尾部管线（Wave-4 抽取）**：`processSessionOutput(stdout, ctx)` 收敛了 runner-execution 与 runner-lightweight 两处近乎逐字的尾部序列——写 .agent.log → stream-json 解析（extractResult/extractUsage）→ tool:call/file:change 事件 → recordSessionMetrics → session:end。两处差异经 ctx 传入（agentRole/stage/sessionCount/isFirstSession/promptSize/sessionMs）；isError 告警与分支保留在调用方（execution 告警后续接循环、lightweight 返回失败），execution 的跨 session token 累计基于返回的 streamUsage 完成。同文件另有 hasRecentActivity（stuck 延期判定）与 queryResolutionHints（RKB）。
- **VPS workspace 解析（2026-08 seam 修复）**：worktree-resolver 的 resolveWorkspace Priority 2 不再手扫 `~/.studio/workspaces/*.json`，改调 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()`——'VPS' 命名约定（name='VPS' 且无 tokenId）的唯一属主在 studio-shared（apps/api workspaces 模块的 local-workspace 也走它），重命名 VPS workspace 的行为变化只影响该函数。
- **provider-hooks（#147 步内前置拦截层，2026-08-15）**：`services/provider-hooks.ts` = per-provider 执法配置生成器，由 propagateHarnessConfig 调用（幂等）。claude 走 `.claude/settings.json` permissions.deny（--print 下 hook 不触发、deny 实测生效）；codex 走项目级 `.codex/hooks.json` PreToolUse；kimi 走 `KIMI_CODE_HOME` per-worktree 隔离 + config.toml [[hooks]]。三者 hook 统一指向 `<worktree>/.studio/command-gate-hook.js`（CommandGate block 级 exit 2）。buildSessionEnv 按 provider=kimi 且 home 已生成时注入 KIMI_CODE_HOME（runner-execution / runner-lightweight 传 worktree）。codex spawn 模板的 trust 门 bypass flag 见 studio-shared CONTEXT.md。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
