# src

> 此文件描述 packages/studio-agent/src 目录的职责和上下文

## 职责

提供 Agent 执行引擎的核心能力，包括任务完成处理（AgentCompleter）、统一执行器（AgentRunner/AgentExecutor）、Agent 注册中心（AgentRegistry）以及角色定义注册表（DEFAULT_PERSONAS）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentExecutor`, `agentExecutor` | services/session-manager.ts | Session 循环执行器（门面，通过 agent-executor.ts 重新导出） |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器，合并 AgentExecutor + TaskExecutor，支持流式 JSON 输出 |
| `AgentCompleter`, `agentCompleter` | services/agent-completer.ts | 任务完成处理器，检测输出文件、解析验证结果、更新状态、发布事件 |
| `getPersona`, `listPersonas`, `DEFAULT_PERSONAS` | registry.ts | 角色定义注册表，提供预置角色（pm、developer、reviewer、tester） |
| `buildSpawnArgs` | cli-adapter.ts | 纯函数，为指定 provider 构建 CLI spawn 参数（command + args） |
| 类型 `Provider`, `SpawnParams`, `SpawnArgs` | cli-adapter.ts | CLI 适配相关类型 |
| 类型 `AgentMetadata`, `JSONSchema` 等 | types.ts | Agent 元数据、JSON Schema 等类型定义 |
| 类型 `AgentTask`, `ExecutionResult` | services/session-manager.ts | 任务与执行结果类型 |

## 依赖关系

**上游（本目录依赖）**:
- `@dommaker/studio-shared`（核心库：logger, eventBus, FileStore, parseStreamEvents, resolveProviderDefinition, buildArgsFromTemplate 等）
- `@dommaker/studio-shared/node`（execSh, resolveSessionId, readSessionIdFile）
- `@dommaker/studio-shared/harness`（parseSessionMetrics）
- `@dommaker/studio-shared/harness/hooks`（beforeAgentExecute）
- `uuid`（生成唯一标识）
- `ajv`、`ajv-formats`（JSON Schema 校验）

**下游（依赖本目录的模块）**:
- `apps/api` 的 daemon 层（session-manager.ts）和 modules/agents、modules/discord 等路由/循环模块

## 注意事项

- **零行为变更原则**：模块拆分（如 agent-runner.ts 拆分为 runner-*.ts）及文件移动必须保持原有公共 API 签名与行为不变。
- **门面模式**：agent-executor.ts 作为门面重新导出 session-manager.ts、agent-runner.ts、worktree-resolver.ts、output-capture.ts 的公共类型与函数，外部应通过门面导入。
- **避免循环依赖**：拆分后的子模块（runner-params、runner-output、runner-execution、runner-lightweight）不得反向依赖 agent-runner.ts 或 session-manager.ts 的类；状态通过 `RunnerExecutionState` 接口传入。
- **Session 循环与轻量路径**：AgentRunner 提供两套执行路径：多 session 循环（runner-execution.ts）和轻量单 session（runner-lightweight.ts），后者跳过 SDD 解析、REQUIREMENTS.md、contract tests、Iron Laws、依赖缓存等，适用于简单任务。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
- **类型安全**：角色定义（DEFAULT_PERSONAS）直接从文件加载，修改时需同步类型约束（AgentPersonaConstraints）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
