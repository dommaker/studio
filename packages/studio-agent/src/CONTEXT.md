# packages/studio-agent/src

### 职责

提供 Agent 执行引擎的核心能力，包括统一执行器（AgentRunner）与 Agent 注册中心（AgentRegistry）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器（execute / executeLightweight / stop / stopProcessGroup / stopAllProcessGroups），支持流式 JSON 输出；stop() 所有权唯一（runningProcesses 只在此注册）；#178 `stopProcessGroup` = kill(-pid) 杀整进程组（fencing 易主/租约场景，ESRCH 跳过、非 ESRCH 回落单杀）；#179（#66 决议 2）`stopAllProcessGroups` = 优雅关闭时 SIGTERM 杀全部注册进程组并清表（不等 step 落盘，api shutdown 调用） |
| `buildSpawnArgs` | cli-adapter.ts | 纯函数，为指定 provider 构建 CLI spawn 参数（command + args） |
| 类型 `Provider`, `SpawnParams`, `SpawnArgs` | cli-adapter.ts | CLI 适配相关类型 |
| 类型 `AgentMetadata`, `JSONSchema` 等 | types.ts | Agent 元数据、JSON Schema 等类型定义 |
| 类型 `AgentTask`, `ExecutionResult`, `ExecutorConfig`, `PrerequisiteCheck` | services/types.ts | 任务、执行结果与执行器配置类型（原 session-manager.ts） |

### 依赖关系

**上游（本目录依赖）**:
- `@dommaker/studio-shared`（核心库：logger, eventBus, FileStore, parseStreamEvents, resolveProviderDefinition, buildArgsFromTemplate 等）
- `@dommaker/studio-shared/node`（execSh, resolveSessionId, readSessionIdFile, resolveVpsWorkspace）
- `@dommaker/studio-shared/harness`（parseSessionMetrics、extractProviderUsage）
- `@dommaker/studio-shared/harness/hooks`（beforeAgentExecute）
- `uuid`（生成唯一标识）
- `ajv`、`ajv-formats`（JSON Schema 校验）

**下游（依赖本目录的模块）**:
- `apps/api` 的 daemon 层（session-manager.ts）和 modules/agents、modules/discord 等路由/循环模块

### 注意事项

- **零行为变更原则（已完成）**：runner-* 拆分（runner-params / runner-output / runner-execution / runner-lightweight）全程保持公共 API 不变；2026-08 删除死去的 AgentExecutor 双胞胎（session-manager.ts，821 行，execute() 为 executeSessionLoop 的重复实现、无生产调用方）完成该重构。唯一行为变化：Discord `/studio stop` 之前调 `agentExecutor.stop`（独立空 map，静默 no-op），现指向 `agentRunner.stop`，停止真正生效。
- **类型归属**：`ExecutorConfig`/`AgentTask`/`ExecutionResult`/`PrerequisiteCheck` 定义在 services/types.ts，由 agent-runner.ts 门面 re-export；外部经 `@dommaker/studio-agent` 包入口导入不变。
- **worktree 拆分明细（2026-08-04）**：scaffolding 写入（writeRequirementsMd/writeContractTests/ensureDeps）位于 worktree-scaffolding.ts，经 worktree-resolver.ts re-export，消费方导入路径不变；prompt 构建与执行前置检查拆为 prompt-builder.ts / prerequisite-checks.ts。
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-execution、runner-lightweight、prompt-builder、prerequisite-checks）不得反向依赖 agent-runner.ts 的类；状态通过 `RunnerExecutionState` 接口传入，公共类型一律从 types.ts 导入。
- **事件统一写口（#361，2026-08-27）**：output-capture 的 5 个发射点（recordSessionMetrics/emitSessionStart/emitSessionEnd/emitToolCall/emitFileChange）全部改走 `@dommaker/studio-shared` 的 `writeStudioEvent`（StudioEvent envelope 形态），删除自抄 appendJsonl 的模块级直连路径——此前在模块加载期固化 `studioPath('logs')`，绕过 STUDIO_EVENTS_FILE 测试隔离（vitest 下 runner 事件落生产 logs）。metrics 等扁平字段并入 payload。`ProcessSessionOutputContext` 增 `sessionExtras`：session:end 与 session:start 携带同一份 workUnitId/transcriptPath（修成功/失败双 payload 形态）。测试注意：写口内部 FileStore/logger 是共享包相对导入，包级 vi.mock 拦不到，断言走 STUDIO_EVENTS_FILE tmp 隔离文件读盘。
- **queryResolutionHints 匹配核心下沉（#361）**：RKB 查询的匹配段（regex 失败回退子串、成熟度闸门、hint 格式化）迁至 studio-shared/resolutions.ts，本文件只保留文档扫描 + fix 提取 + 薄调用；api resolution.service 同批收一。
- **Session 循环与轻量路径**：AgentRunner 提供两套执行路径：多 session 循环（runner-execution.ts）和轻量单 session（runner-lightweight.ts），后者跳过 SDD 解析、REQUIREMENTS.md、contract tests、Iron Laws、依赖缓存等，适用于简单任务。**#171（#54 决议 A1）**：runner-lightweight 的 execSh 调用恒开 `killProcessGroup`（杀步 = 杀进程组，#68 实测 SIGTERM 杀不死孙进程），并按 AgentTask `silenceWarnMs/silenceKillMs/onSilenceWarn` 透传静默看门狗（判据 = 距最后一次输出间隔；agent-loop 配 300s warn / 600s kill + 1800s 墙钟兜底）。
- **runner-briefing（Wave-4 拆分）**：`buildCachePrefix`（CACHE_PREFIX.md）、`writeRequirementsMd`（REQUIREMENTS.md）、`writeContractTests`（__tests__/ 契约测试）从 worktree-resolver 移至 services/runner-briefing.ts——"agent 被告知的内容"的文件桥，与 runner-params.ts 的 buildPrompt 配套（prompt 文本直接引用 REQUIREMENTS.md）。worktree-resolver 现在只保留 git/依赖生命周期（resolveWorkspace / createWorktree / ensureWuWorktree / ensureDeps / propagateHarnessConfig）。唯一调用方是 runner-execution.ts。
- **runner-output spawn 尾部管线（Wave-4 抽取）**：`processSessionOutput(stdout, ctx)` 收敛了 runner-execution 与 runner-lightweight 两处近乎逐字的尾部序列——写 .agent.log → stream-json 解析（extractResult/extractUsage）→ tool:call/file:change 事件 → recordSessionMetrics → session:end。两处差异经 ctx 传入（agentRole/stage/sessionCount/isFirstSession/promptSize/sessionMs）；isError 告警与分支保留在调用方（execution 告警后续接循环、lightweight 返回失败），execution 的跨 session token 累计基于返回的 streamUsage 完成。**#134：ctx 增 `provider`，非 claude provider 的 streamUsage 改走 `extractProviderUsage`（opencode/codex 事件形态 extractUsage 吃不下），claude/缺省行为不变。**同文件另有 hasRecentActivity（stuck 延期判定）与 queryResolutionHints（RKB）。
- **VPS workspace 解析（2026-08 seam 修复）**：worktree-resolver 的 resolveWorkspace Priority 2 不再手扫 `~/.studio/workspaces/*.json`，改调 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()`——'VPS' 命名约定（name='VPS' 且无 tokenId）的唯一属主在 studio-shared（apps/api workspaces 模块的 local-workspace 也走它），重命名 VPS workspace 的行为变化只影响该函数。
- **provider-hooks（#147 步内前置拦截层，2026-08-15；#154 改指 harness shim）**：`services/provider-hooks.ts` = per-provider 执法配置生成器，由 propagateHarnessConfig 调用（幂等）。claude 走 `.claude/settings.json` permissions.deny（--print 下 hook 不触发、deny 实测生效）；codex 走项目级 `.codex/hooks.json` PreToolUse；kimi 走 `KIMI_CODE_HOME` per-worktree 隔离 + config.toml [[hooks]]。codex/kimi 的 hook 统一指向 `@dommaker/harness` 包内 `dist/pretool-use-hook.js`（#154：harness 包出厂 shim，studio-agent 不再生成脚本；旧版 `<worktree>/.studio/command-gate-hook.js` 由 removeLegacyHookScript 自愈清理，kimi 旧配置按 fragment 全串匹配重写迁移）。buildSessionEnv 按 provider=kimi 且 home 已生成时注入 KIMI_CODE_HOME（runner-execution / runner-lightweight 传 worktree）。codex spawn 模板的 trust 门 bypass flag 见本文 `packages/studio-shared` 锚点。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
