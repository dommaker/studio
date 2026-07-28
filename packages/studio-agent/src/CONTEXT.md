# src

> 此文件描述 packages/studio-agent/src 目录的职责和上下文

<!-- STALE_SINCE: 2026-07-28 -->
⚠️ 以下文件已变更，本节可能过期: packages/studio-agent/src/CONTEXT.md, packages/studio-agent/src/index.ts, packages/studio-agent/src/cli-adapter.ts, packages/studio-agent/src/registry.ts, packages/studio-agent/src/types.ts

## 职责

提供 Agent 执行引擎的核心能力，包括任务完成处理（AgentCompleter）、统一执行器（AgentRunner/AgentExecutor）、Agent 注册中心（AgentRegistry）以及角色定义注册表（DEFAULT_PERSONAS）。负责将 provider 抽象参数转化为 CLI 参数（cli-adapter），管理 session 循环与轻量执行路径，并收集输出与指标。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `AgentRegistry` | services/agent-registry.ts | Agent 注册中心，支持注册、发现、缓存、Schema 校验 |
| `AgentExecutor`, `agentExecutor` | services/session-manager.ts | Session 循环执行器（门面，通过 agent-executor.ts 重新导出） |
| `AgentRunner`, `agentRunner` | services/agent-runner.ts | 统一执行器，合并 AgentExecutor + TaskExecutor，支持流式 JSON 输出 |
| `AgentCompleter`, `agentCompleter` | services/agent-completer.ts | 任务完成处理器，检测输出文件、解析验证结果、更新状态、发布事件 |
| `ensureWuWorktree`, 类型 `WuWorktreeInfo` | services/worktree-resolver.ts | B3b-i 每 WU 专属 worktree（`<worktreesDir>/wu-<wuId>` + 分支 `task/<wuId>`，按 WU id 键控跨 step 复用；创建失败清理半成品后抛错） |
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
- **Agent HOME 鉴权注入**：两条路径 spawn 前都会调 `ensureAgentHomeCliConfig(agentHome)`（runner-params.ts），把 host `~/.claude/settings.json` 的 `env` 块按鉴权/模型前缀（ANTHROPIC_/CLAUDE_/OPENAI_/DEEPSEEK_/KIMI_/MOONSHOT_）注入隔离 HOME 的 `.claude/settings.json`；缺了它 claude CLI 在隔离 HOME 下 401。只补缺不覆盖、不带 hooks、best-effort 幂等。
- **Cache 与性能**：AgentRegistry 使用外部 CacheStore（如 Redis），注意 TTL 和缓存键约定（`agent:` 前缀）。
- **工具产物 exclude（fix/guard-and-resume）**：createWorktree 新建成功后写仓库级 `.git/info/exclude`（`.claude/`、`.studio/`、`.daemon/`、`.agent.log`），避免 §10.5 提交守卫被 untracked 工具产物误伤。git 无 per-worktree exclude（2.43 实测 worktree gitdir 的 info/exclude 不生效），写入对所有 worktree + 主 checkout 的 untracked 列表生效；主 workspace 直执路径不经 createWorktree、已有 worktree 复用路径不写（幂等）。刻意不含 AGENTS.md（内容文件）；已知未修：propagateHarnessConfig 无条件覆盖 worktree 里 repo 已跟踪的 AGENTS.md（skill 索引漂移即成未提交改动，仍会触守卫）。
- **会话续用参数（fix/guard-and-resume）**：SpawnParams.sessionResume=true 时 claude 用 `--resume <id>` 替换 `--session-id`（后者 create-only，2.1.80 实测撞已存在 id 报 "already in use"）；kimi/opencode `--session`、codex `exec resume` 本来就是续用语义，模板不变。runner-lightweight 从 `parameters.sessionId + parameters.sessionResume` 透传；`parameters.sessionFlags` 核查非死参数——唯一设置方是旧 daemon 链路（apps/api/src/daemon/session-manager.ts，--continue 续用无此 bug）。
- **类型安全**：角色定义（DEFAULT_PERSONAS）直接从文件加载，修改时需同步类型约束（AgentPersonaConstraints）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-28: fix(guard-and-resume) — ①提交守卫误伤：createWorktree 新建后写仓库级 `.git/info/exclude`（`.claude/`、`.studio/`、`.daemon/`、`.agent.log` 四行工具产物，幂等 best-effort；复用/主 workspace 路径不写）②会话续用 flag：cli-adapter 加 `SpawnParams.sessionResume`（claude 续用 `--resume` 替换 `--session-id`，其余 provider 模板不变）+ runner-lightweight 透传 + AgentTask.parameters.sessionResume 类型；sessionFlags 核查非死参数（旧 daemon session-manager 仍在用）
- ✅ `03971453`: agent): 隔离 agent HOME 注入 claude CLI 鉴权 env，修复 401 authentication_failed
- ✅ 2026-07-28: fix(agent-home-auth) — runner-params 新增 `ensureAgentHomeCliConfig(agentHome)`：spawn 前把 host `~/.claude/settings.json` 的 env 块按鉴权/模型前缀过滤注入隔离 agent HOME（只补缺、不带 hooks、best-effort 幂等），修复 HOME 隔离导致 claude CLI 401 authentication_failed（首 step 失败 + 后续 resume Session ID not found）；runner-lightweight 与 runner-execution 两条 spawn 路径均已接入
- ✅ 2026-07-27: B3b-i — worktree-resolver 新增 ensureWuWorktree/WuWorktreeInfo（每 WU 专属 worktree，目录/分支按 WU id 键控，含 .git 即复用；失败兜底清理 worktree 注册项+目录+分支后抛错）；createWorktree 增第 5 可选参 branchName（缺省保持 task/<basename> 原行为）；经 agent-executor 门面与包入口导出，dist 已重建
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
