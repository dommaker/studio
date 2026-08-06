# src

> 此文件描述 packages/studio-agent/src 目录的职责和上下文

## 职责

提供 Agent 执行引擎的核心能力，包括任务完成处理（AgentCompleter）、统一执行器（AgentRunner）与 Agent 注册中心（AgentRegistry）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器（execute / executeLightweight / stop），支持流式 JSON 输出；stop() 所有权唯一（runningProcesses 只在此注册） |
| `AgentCompleter`, `agentCompleter` | services/agent-completer.ts | 任务完成处理器，检测输出文件、解析验证结果、更新状态、发布事件 |
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
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-execution、runner-lightweight）不得反向依赖 agent-runner.ts 的类；状态通过 `RunnerExecutionState` 接口传入，公共类型一律从 types.ts 导入。
- **Session 循环与轻量路径**：AgentRunner 提供两套执行路径：多 session 循环（runner-execution.ts）和轻量单 session（runner-lightweight.ts），后者跳过 SDD 解析、REQUIREMENTS.md、contract tests、Iron Laws、依赖缓存等，适用于简单任务。
- **VPS workspace 解析（2026-08 seam 修复）**：worktree-resolver 的 resolveWorkspace Priority 2 不再手扫 `~/.studio/workspaces/*.json`，改调 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()`——'VPS' 命名约定（name='VPS' 且无 tokenId）的唯一属主在 studio-shared（apps/api workspaces 模块的 local-workspace 也走它），重命名 VPS workspace 的行为变化只影响该函数。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
