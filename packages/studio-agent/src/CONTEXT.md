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
- **工具产物 exclude（fix/guard-and-resume）**：createWorktree 新建成功后写仓库级 `.git/info/exclude`（`.claude/`、`.studio/`、`.daemon/`、`.agent.log`），避免 §10.5 提交守卫被 untracked 工具产物误伤。git 无 per-worktree exclude（2.43 实测 worktree gitdir 的 info/exclude 不生效），写入对所有 worktree + 主 checkout 的 untracked 列表生效；主 workspace 直执路径不经 createWorktree、已有 worktree 复用路径不写（幂等）。刻意不含 AGENTS.md（内容文件）。
- **工作区指南传播（2026-07-28 P2 修订）**：propagateHarnessConfig 不再往 worktree 根写/覆写 AGENTS.md、CLAUDE.md——仓库已有两者之一一律不碰（原 AGENTS.md 无条件覆写令 repo 已跟踪文件随 skill 索引漂移成未提交改动、误伤守卫）；都没有时生成内容改落 `.studio/AGENTS.generated.md`（在 exclude 内，git status 不可见），agent-loop 的 base prompt 指引 agent「存在则阅读，根 AGENTS.md/CLAUDE.md 优先」。skill 全文落盘 `.studio/skills/<name>/SKILL.md` 不变。
- **会话续用参数（2026-07-28 P3 实证修订）**：SpawnParams.sessionResume=true 时——claude `--resume <id>`（2.1.80 实测，id 按 HOME+cwd 存储）；kimi/opencode `--continue`、codex `exec resume --last`（cwd 维度续用，不接 id）。Studio 持有的 sessionId 是自建 UUID，kimi 0.29.0/opencode 1.18.4 实测对未知 id 报 "Session not found"，codex 同为 resume 语义 → 新建对这三家一律丢弃 sessionId（RESUME_ONLY_SESSION_PROVIDERS），CLI 自建会话。实证状态：kimi/opencode 运行实测通过（含 cwd 隔离、无前会话优雅新开）；codex 仅 --help 实证（本机 codex 0.144.4 与 DeepSeek wire_api=chat 配置不兼容，无法发起会话，stdin 形态未验证）。runner-lightweight 从 `parameters.sessionId + parameters.sessionResume` 透传；`parameters.sessionFlags` 是旧 daemon 链路的 claude 专属通道（--session-id/--continue），与 buildSpawnArgs 无关。
- **类型安全**：角色定义（DEFAULT_PERSONAS）直接从文件加载，修改时需同步类型约束（AgentPersonaConstraints）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-28: spawn 链路退役 tier→模型名解析（方案 A：模型归算力提供方，由 CLI 自身配置决定）— runner-lightweight/runner-execution/session-manager 删除 getModelForTier 调用（本就未传入 spawn 参数，仅日志用），日志字段 model → modelTier 标签；getModelForTier 本体从 studio-shared 删除
- ✅ `faa07b29`: agent): repoDir CLAUDE.md 仅同仓传播 + exclude 补 .harness/（验收修复 C，P2 续）
- ✅ 2026-07-28: 验收修复 C（P2 续）— ①propagateHarnessConfig 的 repoDir CLAUDE.md 复制改为仅同仓库传播（isSameGitRepo 经 --git-common-dir 判定，失败=false）：频道链路 worktree 属 WU 工程仓、repoDir 是 studio 默认仓，跨仓复制即 untracked 内容文件（不在 exclude），提交守卫恒非空把 COMPLETE 反复打回（e2e 实测 dev 提交后仍 16 步空转强制 in_review）②WORKTREE_EXCLUDE_PATTERNS 增补 `.harness/`（propagateHarnessConfig 无条件创建，模板存在时即污染源）；worktree-agents-md.test.ts 补 3 例（跨仓/同仓/非 git）
- ✅ `2dca78ab`: agent): 非 claude provider 会话续用改 cwd 维度形态（P3）
- ✅ `b70951bb`: agent): harness 传播停写根目录 AGENTS.md/CLAUDE.md，杜绝 untracked 污染（P2）
- ✅ `fed49d2b`: agent): 提交守卫排除工具产物 + 会话续用改 resume 语义
- ✅ 2026-07-28: P3 非 claude 会话续用修通 — cli-adapter 逐 provider 实证修订：kimi 0.29.0/opencode 1.18.4 实测 `--session <未知id>` 报 Session not found（Studio UUID 对 CLI 无意义），续用改 `--continue`（cwd 维度，实测续用成功、异 cwd 不串、无前会话优雅新开）；codex 改 `exec resume --last`（--help 实证：cwd 过滤最新会话；运行未验证——本机 codex 与 DeepSeek wire_api=chat 不兼容）；新建对 kimi/codex/opencode 一律丢弃 sessionId（RESUME_ONLY_SESSION_PROVIDERS）；claude --resume 行为不回归；cli-adapter.test.ts 改写 22 例
- ✅ 2026-07-28: P2 harness 传播污染修复 — propagateHarnessConfig 停写/覆写 worktree 根 AGENTS.md、CLAUDE.md（已有不覆盖，对齐原 CLAUDE.md 行为；原 AGENTS.md 无条件覆写令 repo 已跟踪文件随 skill 索引漂移误伤 §10.5 提交守卫），无原生指南时生成内容改落 `.studio/AGENTS.generated.md`（exclude 内，零 untracked 污染）；agent-loop base prompt 加「.studio/AGENTS.generated.md 存在则阅读」指引；worktree-agents-md.test.ts 改写为新语义 7 例（无/有/有且内容不同/CLAUDE.md/draft/复制失败/manifest 失败）
- ✅ 2026-07-28: fix(guard-and-resume) — ①提交守卫误伤：createWorktree 新建后写仓库级 `.git/info/exclude`（`.claude/`、`.studio/`、`.daemon/`、`.agent.log` 四行工具产物，幂等 best-effort；复用/主 workspace 路径不写）②会话续用 flag：cli-adapter 加 `SpawnParams.sessionResume`（claude 续用 `--resume` 替换 `--session-id`，其余 provider 模板不变）+ runner-lightweight 透传 + AgentTask.parameters.sessionResume 类型；sessionFlags 核查非死参数（旧 daemon session-manager 仍在用）
- ✅ `03971453`: agent): 隔离 agent HOME 注入 claude CLI 鉴权 env，修复 401 authentication_failed
- ✅ 2026-07-28: fix(agent-home-auth) — runner-params 新增 `ensureAgentHomeCliConfig(agentHome)`：spawn 前把 host `~/.claude/settings.json` 的 env 块按鉴权/模型前缀过滤注入隔离 agent HOME（只补缺、不带 hooks、best-effort 幂等），修复 HOME 隔离导致 claude CLI 401 authentication_failed（首 step 失败 + 后续 resume Session ID not found）；runner-lightweight 与 runner-execution 两条 spawn 路径均已接入
- ✅ 2026-07-27: B3b-i — worktree-resolver 新增 ensureWuWorktree/WuWorktreeInfo（每 WU 专属 worktree，目录/分支按 WU id 键控，含 .git 即复用；失败兜底清理 worktree 注册项+目录+分支后抛错）；createWorktree 增第 5 可选参 branchName（缺省保持 task/<basename> 原行为）；经 agent-executor 门面与包入口导出，dist 已重建
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
