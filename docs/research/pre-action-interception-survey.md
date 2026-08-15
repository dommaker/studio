# 步内前置拦截层——需求盘点与 provider 机制 survey（issue #138）

> 研究票：issue #138（dommaker/studio）。调研日期 2026-08-15。
> 本文只出调研结论与「是否立项」建议，不定案、不实现。步收尾 completion-gates 归 #82/#129，本票不越界。
> 口径：studio 侧代码行号对 master HEAD（#143 蒸馏主链路最小闭环之后的当前工作树）；harness 侧对 `/root/projects/harness` 当前工作树。

## 调研范围与方法

以一手来源为准：官方文档、官方仓库源码/CHANGELOG、GitHub issues（`gh api` / `gh search`）、本仓与 harness 仓源码、本机 CLI 实测。逐条结论附来源 URL；无法从一手来源核实的显式标注「未核实」或「假设」。

**环境限制说明**：

- `code.claude.com/docs` / `docs.anthropic.com` 不可达（超时）。Claude Code hooks 语义改用 `anthropics/claude-code` 仓库内 `plugins/plugin-dev/skills/hook-development/`、`examples/hooks/`、CHANGELOG 与官方 issues 交叉核实；该仓库无 TS 源码（闭源），触发路径只能从文档 + issue 复现证据定论。
- `moonshotai.github.io/kimi-code` 与 `openai/codex` 文档可达性由 provider 小节分别记录。

| 对象 | 一手来源 |
|------|---------|
| 现状零接线 | studio 仓库源码（`apps/api`、`packages/studio-agent`、`packages/studio-shared`）、harness 仓库源码（`src/gates/command.ts`）、本机 `~/.claude/settings.json`、`.claude/settings.json`、`~/.codex/config.toml` |
| 候选清单事故证据 | 本仓 git log、`~/.studio/knowledge/`（含 archive）、`studio/docs/issues/`、GitHub issues（anthropics/claude-code） |
| claude | `anthropics/claude-code` 仓库 hooks skill/example + 官方 issues（`gh api`） |
| codex | `openai/codex` 仓库 `docs/`、releases 页（CHANGELOG.md 是跳转 stub） |
| opencode | `anomalyco/opencode` 仓库（`sst/opencode` 已被 gh 重定向回 anomalyco）、插件文档、#5894 |
| kimi | `kimi --help` + `kimi -p` 本机实测、`moonshotai.github.io/kimi-code` 文档、`MoonshotAI/kimi-code` 仓库源码 |

## 1. 现状零接线复核（代码证据）

**结论：「执法强度为 0」对「步内 per-tool 前置拦截」这个具体层成立，但需精确化**——能力面（CommandGate 黑名单、checkBeforeExecution、PostToolUse 观测）已存在且 dev 上下文部分接线，只是 agent 执行 spawn 路径（worktree）零接线。分四层看：

### 1.1 拉取式 MCP 工具（零主动调用方）

`checkConstraint` / `checkGuardrail` / `getSandboxLevel` 定义于 `apps/api/src/modules/mcp/safety.tools.ts:11-116`，经 `tools.ts:30-64` 注册进 `allTools`。全仓 grep 其调用方只有三类：MCP 泛化分发（`mcp/server.ts:138`、`mcp/routes.ts:133` 的 `executeTool`）与测试。**没有任何生产代码在 agent 行动前主动调用它们**——它们是「拉取式工具」，agent 自己愿意调才会执行，等效零执法。`checkConstraint` 的 handler 内部才调 `constraintService.checkConstraints`（`safety.tools.ts:30`），即约束检查能力存在但挂在 agent 自愿触发的工具后面。

### 1.2 harness check-input/check-output 路由（挂载但零生产调用方）

`POST /check-input`、`POST /check-output` 定义于 `apps/api/src/modules/harness/guards.routes.ts:22-62`，经 `routes.ts` 门面挂 `/api/v1/harness`。grep 全仓，调用方只有测试（`guards.routes.test.ts`）与 spec 文档（`docs/specs/infra/FL-034-safety-guards.md`）。agent-loop 与 spawn 路径从不调它们。挂载 ≠ 执法。

### 1.3 checkBeforeExecution（步前 Iron Laws 检查）——已接线，但是「步前一次」粗粒度，非「步内 per-tool」

harness 的 `checkBeforeExecution()` 在 studio 确有接线：`runner-execution.ts:103` 调 `beforeAgentExecute` → `agent.hooks.ts:17` 调 `checkBeforeExecution({operation:'code_implementation', ...})`，hook 配置 `config.ts:27` 标记 `blocking: true`（失败抛异常阻断）。**但这是每个 step spawn 前对 Iron Laws 的整步级前置检查**（hasTest/hasWorktree/evidence 等过程性约束），检查粒度是「这一个 step 该不该起」，不是「这个工具调用该不该执行」。因此它不覆盖票面定义的「步内行动前拦截」（per-tool、单动作判定）。

### 1.4 真正的 per-tool 前置拦截：能力已存在，但只接在 dev 上下文，spawn 路径零接线

harness 已有命令黑名单门禁 `CommandGate`（`harness/src/gates/command.ts`，SEC-006，`DEFAULT_COMMAND_BLACKLIST` L23-193：`rm -rf /`、`rm -rf *`、`rm -rf ~|/home`、`chmod 777`、`DROP DATABASE/TABLE`、`curl|bash`、`sudo rm/dd/fdisk`、`kill -9 -1` 等，block/warn/audit 三级），并有现成的 **PreToolUse hook 接线**——但只在仓库级 `/root/projects/studio/.claude/settings.json`：

```json
"permissions": { "deny": ["Bash(rm -rf *)", "Bash(git push --force*)", "Bash(git reset --hard*)"] },
"hooks": { "PreToolUse": [{ "matcher": "Bash",
  "command": "node -e \"const {CommandGate} = require('/root/projects/harness/dist/gates/command'); ... process.exit(1);\"" }] }
```

（注意：该 hook 用 `process.exit(1)`，不是票面说的 exit 2，见 §3.1。）

问题在 **agent 执行 spawn 路径不走这份配置**：`worktree-resolver.ts:198-225` 给每个 worktree 写自己的 `.claude/settings.json`，内容只有 `permissions.defaultMode:'bypassPermissions'` + `mcpServers`（studio/local-rag），**无 deny 规则、无 PreToolUse hook**；spawn 的 cwd = worktree（`runner-execution.ts:250-251` `execSh(cmd,{cwd:worktree})`），所以仓库级 `studio/.claude/settings.json` 的 PreToolUse + deny 对 spawn 的 executor **不生效**。用户级 `~/.claude/settings.json` 只有 `PostToolUse`（knowledge-track/sensitive-check/memory-sync）、`Notification`、`Stop`——全是**事后观测/通知**，无 PreToolUse，`harness-sensitive-check.sh` 是 PostToolUse（命令已执行完才查，只能告警不能阻断「既遂」）。

**净结论**：票面「能力面已存在（checkConstraint/checkGuardrail、check-input/check-output）但零接线、执法强度为 0」——对「步内 per-tool 前置拦截」成立；但要补一条重要事实：**per-tool 前置拦截的现成实现（CommandGate + PreToolUse hook + permission deny）已经在仓库级 `.claude/settings.json` 里为 dev 自己的 claude 接好了，唯独没有接到 studio 的 agent spawn 路径（worktree）**。这不是「从零造」，而是「把已有 dev 侧机制推广到 spawn 侧 + 修 provider 可行性」。

## 2. 候选清单逐一验证（4 类）

verdict 两档：**有证据**（真实事故/险情记录或端到端实证）、**假设**（无直接事故记录，降级为风险假设）。

| # | 候选逻辑 | verdict | 证据 / 来源 |
|---|---------|---------|------------|
| 1 | 外发动作：git push（尤其 force）/发消息/curl 上传第三方 | **有证据** | 一手 issue：Claude Code「routine `git push` 触发未授权生产部署」（anthropics/claude-code #83513，2026-08-03，open）；「无视 CLAUDE.md 禁止而 commit+push」（#58079，#67060）；「无确认执行不可逆 git 操作 merge/push」（#69156）。本仓侧：`discord-notifier.ts` 曾把明文 bot token 拼进 exec 命令串、报错时整条（含 token）落日志（commit `c23d5776`）。 |
| 2 | 凭证泄露：命令/文件写命中 token/key 模式 | **有证据（泄露面真实存在，但「agent 步内写入」为假设）** | 一手/近一手：GitGuardian 2025 年报「29M 泄露 secrets，AI agent 凭证失控」（Help Net Security 转述，二手）；「Comment and Control」PR 标题提示注入窃取 Claude Code/Gemini CLI/Copilot 的 API key（Lyrie Research，二手）。本仓侧：`~/.claude/settings-deepseek.json` 曾硬编码 `STUDIO_API_KEY` 明文（`docs/sdd/2026-07-system-llm-migration/requirement.md` AC-7.15 + `docs/plans/2026-07-system-llm-migration.md`）；`PIT-019` 记录 HOME 隔离导致「明文 token 散落」。**但「agent 在步内把 token 写进命令/文件」这一具体泄露向量在本仓无直接事故记录 → 该子项降级为假设**。 |
| 3 | 危险销毁：rm -rf / reset --hard / 删 worktree 与数据目录 | **部分有证据（误删代码文件已发生且 git 可纠；rm -rf/数据目录销毁为假设）** | 本仓两起真实误删：commit `2352a87b`「恢复误删的 A 类代码（已实现未接入）」——前序 commit `beeeb8a8` 把 1458 行已实现未接入代码当死代码删了，靠 `git checkout` 恢复；commit `008912d` 把 `companies` 模块（8 文件）当死表清理误删，后由 `5e67bf92` 重建。外部：Claude agent 删光某公司整个生产数据库（The Guardian 2026-04-29，二手新闻）；Gemini 3.5 在「8 处认证漏洞修复」任务里误删 28745 行/340 文件（zhidx.com 编译 Reddit，二手）。**这些「误删」均落在 git 可恢复的代码文件内；`rm -rf` 命中数据目录、`git reset --hard`、删 worktree 的「既遂不可纠」级事故在本仓无记录 → 该子项降级为假设**。 |
| 4 | 越权写：agent 写自己 worktree 之外的路径（主仓库、~/.studio/） | **假设（有机制前提，无事故记录）** | 一手 issue 佐证该风险真实存在：Claude Code「worktree 隔离的子代理把 Edit/Write 泄漏到父 checkout」（#57847，Windows，closed）。本仓侧**机制前提成立但无事故**：worktree `.claude/settings.json` 声明 `bypassPermissions`（`worktree-resolver.ts:208`），executor 进程本可写主仓库与 `~/.studio/`；本仓无「agent 越界写主仓库/数据区造成损害」的记录 → 降级为假设。 |

补充（不属 4 类，但同属「既遂不可纠」的旁证）：2026-08-03 无人值守期间 1.03 亿 token 消耗（`docs/issues/2026-08-03-unattended-token-burn.md`）——钱已烧、不可纠，但其归属层是「预算熔断/会话上限」（已按 B5/C3 落地）而非 per-tool 前置拦截，故不并入候选清单，只作「既遂不可纠损害真实存在」的旁证。

## 3. Provider survey

每 provider 给：机制名 / 配置载体 / 阻断语义 / **在 studio 实际 spawn 模式下的可行性结论** / 版本出处。并复核票内起点准确性。

### 3.1 claude

- **机制**：`hooks.PreToolUse`（PostToolUse/Stop/Notification 同族），配置于 `~/.claude/settings.json`（用户级）或项目 `.claude/settings.json`（另有 `.claude/settings.local.json`、企业 `managed-settings.json`），matcher 按工具名（`Bash`、`Read|Write|Edit`、`*`、正则 `mcp__.*`、`if:` 条件如 `Bash(git commit:*)`），stdin 传 JSON（`tool_name`/`tool_input.command` 等）。阻断语义（交互模式）：**exit 0=允许**；**exit 2=阻断**（stderr 回给 Claude、阻止工具执行）；**exit 1 等其他码=非阻断错误**（stderr 只显示给用户、不回传、不阻断）。另有 JSON 决策输出 `{"hookSpecificOutput":{"permissionDecision":"allow|deny|ask|defer"}}`（`deny` 等价阻断；`defer` v2.1.89 起）。附加风险：`allowedTools:["*"]` 会整体跳过 hook 管道（#36071）。
- **关键结论（票内未覆盖的出入）**：studio 实际以 `claude --print --output-format stream-json`（`providers.ts:99`）非交互 spawn——**该模式下 PreToolUse hook 不触发、exit 2 无法阻断工具调用**。此为 Anthropic 长期「not planned」的限制，跨 v2.1.41 → v2.1.142 复现：`#20063`「hooks don't run in headless mode」（2026-01-22）、`#30143`「PreToolUse/PostToolUse hooks don't fire in non-interactive -p mode」（2026-03-02）、`#33343`「PreToolUse hooks and --allowedTools not enforced in headless -p mode」（含 stream-json 无 `hook_request`/`hook_response` 事件的可复现证据）、`#36071`「PreToolUse hooks don't block in headless (-p) mode or with allowedTools wildcard」、`#40506`「PreToolUse hooks do not fire in non-interactive mode (claude -p)」。5 个 issue 里 4 个 `state_reason=not_planned`（关闭但不修）；唯一 `completed` 的 #30143 实为「判重后自动关闭」（bot 标记为 #20063 的 duplicate，非修复）。
- **在 studio spawn 模式的可行性**：**不可行（当前 spawn 形态下）**。claude 的原生 PreToolUse hook 在 `--print` 非交互下不生效，不能作为 studio 步内前置拦截的执法面。
- **复核票内起点**：机制名/载体/exit 2 语义对交互模式准确；但「claude：PreToolUse hooks（settings.json，exit 2 阻断）」若作为 studio 拦截机制起点，**漏了 `--print` 模式下不生效这一决定性出入**。
- **版本出处（CHANGELOG）**：v1.0.38「Released hooks」（机制引入）；v2.0.10 PreToolUse 可改 `tool_input`；v2.1.9 PreToolUse 可返回 `additionalContext`；v2.1.90「Fixed PreToolUse hooks that emit JSON to stdout and exit with code 2 not correctly blocking the tool call」（exit-2 阻断修复）；v2.1.214「Fixed hooks with exit code 2 not blocking ... stdout JSON fails schema validation」。**注：以上修复均针对交互模式，`-p` 非交互不触发的问题始终 not_planned。**
- 来源：https://github.com/anthropics/claude-code/issues/20063 、/30143 、/33343 、/36071 、/40506；机制语义参考 `anthropics/claude-code` 仓库 `plugins/plugin-dev/skills/hook-development/SKILL.md`、`examples/hooks/bash_command_validator_example.py`、CHANGELOG.md（`code.claude.com/docs` 本次不可达）。

### 3.2 codex

- **机制**：lifecycle hooks（Rust `codex-rs/hooks`，引擎名 `ClaudeHooksEngine`——兼容 Claude 风格 hooks）。事件：`PreToolUse`/`PostToolUse`/`PermissionRequest`/`UserPromptSubmit`/`Stop`/`SessionStart`/`SessionEnd`/`PreCompact`/`PostCompact`/`SubagentStart`/`SubagentStop`。
- **载体（两种并存）**：`config.toml` 的 `[hooks]` 段（TOML）+ 独立 `hooks.json`（`{description, hooks}`，从 `<config_folder>/hooks.json` 读）。**分层**：全局 `~/.codex/config.toml`、`~/.codex/hooks.json`；项目 `.codex/config.toml`、`.codex/hooks.json`；系统 `/etc/codex/config.toml`（unix）。matcher 匹配 `tool_name`（`Bash`/`Edit|Write`/`^Bash$`/`mcp__.*__write.*` 正则；`*`/空=全部）。stdin 单条 JSON（PreToolUse 含 `tool_name`/`tool_input`/`tool_use_id` 等）。
- **阻断语义**（源码 `pre_tool_use.rs` `parse_completed`）：**exit 0=允许**（stdout 为 JSON 时可进一步 `permissionDecision:"deny"` 阻断 / `updatedInput` 改写输入 / `additionalContext`）；**exit 2=阻断**（stderr 作 reason，stderr 为空则判 Failed）；**其他 exit code / 无 exit code = Failed，不阻断（fail-open）**。仅**同步** command hook 能施加控制效果（`async:true` 不阻断）。
- **在 studio spawn 模式的可行性：可行**。`codex exec --json` 非交互 hooks **会加载、能阻断**：加载门槛仅是 feature flag `CodexHooks`（Stable、default_enabled，非 TUI 专属）；`codex exec` 与 TUI 共用同一 core 会话/线程/turn 循环，无 headless 旁路；工具派发统一走 `run_pre_tool_use_hooks`（无交互判断），`Blocked` → 工具不执行。端到端实证（core harness 无 TUI）：`pre_tool_use_blocks_shell_command_before_execution`（json deny）与 `pre_tool_use_blocks_exec_command_before_execution`（exit_2+stderr）均断言命令未执行。例外：Windows 在 0.117.0 起禁用 hooks；Linux/macOS 生效。
- **复核票内起点（出入）**：「2026-02 v0.117 起引入 hooks」**日期错、归属需修正**——hooks 引擎（实验）0.114.0（2026-03-11，仅 SessionStart+Stop，#13276）引入；**PreToolUse 0.117.0（2026-03-26，#15211）** 才加入；`rust-v0.117.0` 发布于 2026-03-26，非 2026-02。「hooks.json/config.toml」属实（两种载体）；「exit 2 阻断」属实（stderr 为 reason）；「有端到端实证」属实。
- **环境限制**：`developers.openai.com` 的 config-reference 被 Cloudflare 拦截（HTTP 403），文档原文未能直引；行为结论以 GitHub 源码 + 集成测试为准。本机 `~/.codex/config-deepseek.toml` 仅有 `notify = [...]`（通知 hook），无 PreToolUse 阻断接线。
- 来源：https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs ；https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs#L337 ；https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/hooks.rs ；release https://github.com/openai/codex/releases/tag/rust-v0.117.0 、/rust-v0.114.0 ；PR https://github.com/openai/codex/pull/15211 。

### 3.3 opencode

- **机制**：插件 hook `tool.execute.before`（`@opencode-ai/plugin` 的 Plugin 返回对象），throw 即阻断该次工具调用（错误回给模型）。
- **复核 #5894 现状（一手核实）**：`anomalyco/opencode#5894`「Plugin hooks (tool.execute.before) don't intercept subagent tool calls - security policy bypass」，2025-12-21 开，**2026-04-15 被 bot 因 90 天无活动自动关闭**（`state_reason=completed`），**非因修复关闭**。issue 内维护者评论（2026-02-13）指出：① 原「子代理绕过」极可能误诊——子代理实际用 `bash` 跑 grep/glob，hook 只看到 `tool:"bash"` 而非 `tool:"grep"`；插件按 Instance 加载，子代理工具调用 hook **本会触发**。② 真正未触发的洞是 **`batch.ts` 直接调 `tool.execute()` 不经 `Plugin.trigger()`**——经 batch 工具调用的子工具完全绕过插件 hook；且 `tool.execute.before/after` 在 `prompt.ts` 里重复 3 处（有 TODO「centralize invoke tool logic」）、都不传 agent 信息。「正在修 batch 盲点 + 集中 hook」——**截至自动关闭无「已修复」确认**。
- **票内起点出入**：票面「已知 bug：子 agent 工具调用可绕过（#5894）」把绕过路径归为「子 agent」，与维护者核实不符——子代理路径大概率误诊，真实绕过是 **batch 工具盲点**。
- **在 studio spawn 模式的可行性**：`opencode run --format json` 走 in-process server、创建项目 Instance（`packages/opencode/src/cli/cmd/run.ts`：`instance: (args) => !args.attach`），插件按 Instance 加载——故 `run` 模式**会加载插件、`tool.execute.before` 会触发**（与 #5894 维护者「plugins are loaded per-Instance」一致）。但插件是**代码文件**（`.opencode/plugin/*.ts`），作为执法面其生成/管理成本高于纯配置（codex/kimi）。
- **batch 盲点修复状态（未定论）**：集中化已跟踪为 issue `#13524`「refactor: centralize tool plugin hooks + add agent to hook input」（2026-02-13 开，与 #5894 评论同日），**2026-04-17 因 90 天无活动自动关闭**（`state_reason=completed`），**无「已合并修复」确认**。即 batch 盲点是否已修**未定论**，实现票若用 opencode 执法面需先实测 batch 工具是否绕过。
- 来源：https://github.com/anomalyco/opencode/issues/5894（正文 + 2026-02-13 ArmirKS 评论）；https://github.com/anomalyco/opencode/issues/13524 ；run 命令源码 https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/cli/cmd/run.ts ；插件文档 https://opencode.ai/docs/plugins 。

### 3.4 kimi（Kimi Code CLI，本机实测定论）

- **身份修正**：`kimi` = **Kimi Code CLI**，npm 包 `@moonshot-ai/kimi-code` 0.31.0；仓库是 **`MoonshotAI/kimi-code`**，**不是票内的 `moonshotai/kimi-cli`**（后者是旧 Python CLI，现产品由其迁移而来）。
- **机制**：`hooks.PreToolUse`（前置、可阻断）+ `UserPromptSubmit`/`Stop`（可阻断）+ 13 个 fire-and-forget 事件，共 16 事件。载体 `~/.kimi-code/config.toml` 的 `[[hooks]]` 数组（`KIMI_CODE_HOME` 可覆盖 home；**无项目级 hooks**）。schema：`event`(必填)/`matcher`(正则，非 glob，PreToolUse 匹配工具名)/`command`(必填)/`timeout`(1–600s 默认 30)。stdin = JSON(snake_case)，PreToolUse 带 `tool_name`/`tool_input`/`tool_call_id`。
- **阻断语义（已实证定论）**：`resultFromExitCode`——**exit 2 = 阻断**（reason=stderr 回填模型）；**exit 0 + stdout JSON `{"hookSpecificOutput":{"permissionDecision":"deny"}}` = 阻断**（reason=`permissionDecisionReason`）；**其余全放行（fail-open）**：exit 1、exit 3+、spawn 失败、timeout 都不阻断。
- **本机端到端实证（精确）**：用 `KIMI_CODE_HOME=/tmp/...` 隔离 home（复用现有凭证软链，未动 `~/.kimi-code`），`kimi -p "..."` 非交互下——exit 2 阻断 `UserPromptSubmit`（输出 `error: failed to run prompt: Prompt hook blocked the request.`）与 `PreToolUse`（`Read` 工具调用前被拦，模型报 `PRETOOLUSE-BLOCK-REASON`）；exit 1 放行（模型正常回复 `Hi!`）；exit 0+JSON deny 阻断（reason=`DENIED-BY-JSON-TEST`）。
- **在 studio spawn 模式的可行性**：**可行**。kimi 的 PreToolUse hook 在 `kimi -p`（studio 的 `--prompt` 非交互形态，`providers.ts:117-124`）下**触发且能 exit 2 阻断**——与 claude 相反。子代理实测用 `--output-format text`；studio 用 `stream-json`，hook 语义应一致（钩在工具执行路径上，与输出格式无关），此点可在实现票用 stream-json 复验一次。
- **复核票内起点**：「config.toml 有 hooks」**准确**，但路径是 `~/.kimi-code/config.toml`（非 `~/.kimi/`）；「阻断语义未实证」当时准确，**现已实证**，且补两条关键语义：exit 1 放行、JSON deny 阻断。
- **版本出处**：hooks 自最早公开 release 0.2.0（2026-05-26）即含；HookEngine 于 PR #165（0.5.0）迁入 `agent-core/src/session/hooks`；CHANGELOG 最早可考条目 0.6.0（PR #195 阻断消息入上下文、#200 阻断会话保留）。
- 来源：https://moonshotai.github.io/kimi-code/en/customization/hooks.html ；https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/CHANGELOG.md ；https://github.com/MoonshotAI/kimi-code/pull/195 ；旧仓 hooks 源码 https://github.com/moonshotai/kimi-cli/blob/main/src/kimi_cli/hooks/config.py 。

> **横贯结论（4 家）**：原生 per-tool 前置阻断在 studio 的**非交互 spawn 形态**下——**codex、kimi、opencode 三家可行**（codex `exec --json` 源码+端到端测试证实；kimi `-p` 本机实证 exit 2 阻断；opencode 插件 throw 阻断、`run` 经实例加载插件），**唯独 claude（studio 默认 provider）不可用**（`--print` 下 PreToolUse 不触发，not_planned）。因此「统一抽象 = 每个 provider 映射自己的原生 pre-tool hook」**对 codex/kimi/opencode 成立**，但对 claude 必须另找执法面（见 §4/§5）。

## 4. 抽象形态验证

**结论：票面「registry 加 capability 字段 + 各 provider 映射自己的机制、与 sessionFlags/maxTurns 模板同构」只对了一半——「各 provider 映射自己的 pre-tool hook」对 codex/kimi/opencode 成立，但 hooks 是磁盘配置而非 spawn flag（形态不同构），且 claude 的原生 hook 在 studio 的 spawn 形态下不可用（需另一执法面）。**

理由：

1. **形态不同构（决定性）**：sessionFlags/maxTurns 是**spawn argv 参数**，`buildArgsFromTemplate`（`providers.ts:296-341`）在每次 spawn 时把 flag 拼进命令行即可，纯声明、无副作用。而 hooks 是**磁盘配置文件**（claude `settings.json`、codex `config.toml`/`hooks.json`、opencode `.opencode/plugin/*.ts`、kimi `~/.kimi-code/config.toml`），在 spawn 前就要**写入 provider 自己的配置目录**，还要考虑与既有配置合并、作用域（用户/项目/worktree）、以及写坏后的回滚。它是「生成/管理配置」动作，不是「声明能力」字段——所以 registry 里放一个 `preToolHook` capability 字段**不足以承载执法**，真正的执法面在写配置的一方（对应 `worktree-resolver.propagateHarnessConfig`）。
2. **能力不齐，不能平铺成布尔字段**：claude 的 PreToolUse 在 `--print` 下 not_planned（§3.1），codex `exec --json` 可用、kimi `-p` 可用、opencode 有 batch 盲点。一个布尔 capability 字段掩盖了「机制存在」与「机制在 studio spawn 形态下可用」之间的鸿沟，且对 claude 是**误导**（声明了却不可用）。
3. **正确的抽象方向（分两层，且要带 per-provider 可用性限定）**：
   - **检测/声明层**：registry 可加**非布尔、带限定条件**的 capability 描述（如 `preToolHook: { kind:'config-toml-hooks', matcher:'PreToolUse', headlessSupport:true }`，claude 记为 `headlessSupport:false`），供上层「知道能不能用」。
   - **生成/管理层**：执法面在**写 provider 配置文件的一方**（今天 `worktree-resolver.propagateHarnessConfig` 写 `.claude/settings.json` 的位置），抽象成「per-provider 的 hook 配置生成器」——与 sessionFlags/maxTurns 的 per-provider 模板**同构**（每个 provider 一段生成逻辑），但产物是磁盘文件而非 argv。
   - **claude 的例外**：因 `--print` 下原生 hook 不触发，claude 不能走「生成 hook 配置」，需另选执法面（见 §5.3——permission deny 是否在非交互下仍拦、或 spawn 层命令代理/沙箱）。
4. **现成可复用的近道**：per-tool 拦截逻辑（CommandGate 黑名单）与 provider 无关，已在 harness 侧实现、已在 dev 侧 claude 上以 PreToolUse hook 跑通。抽象要解决的问题是「**把 CommandGate 落到每个 provider 的可用执法面上**」：codex/kimi/opencode 用其原生 hook（生成配置），claude 用权限/沙箱层——而不是「怎么统一各 provider hook」这一个假问题。

## 5. 立项建议

### 5.1 逐条对照适配标准（单动作即可判定 + 既遂不可纠）

| 候选逻辑 | 单动作可判定 | 既遂不可纠 | 归层判定 |
|---------|------------|-----------|---------|
| git push（尤其 force）/外发上传 | ✅ 单条命令即可判 | ✅ push/上传后不可撤销 | **步内前置** |
| 凭证写命中 token/key 模式 | ✅ 单次写/单条命令即可判 | ⚠️ 写错文件可 git 撤，但一旦 push/外发即扩散；本地写入本身可纠 | **半归步内前置**（本地写命中可降级为步收尾 hint；外发携带才既遂） |
| rm -rf / reset --hard / 删数据目录 | ✅ 单条命令即可判 | ✅ 不可纠 | **步内前置** |
| 越权写 worktree 之外 | ✅ 单次写路径可判 | ⚠️ 写主仓库/数据区可 git/无版本可纠性不一；写 `~/.studio/` 数据区无版本回滚 | **步内前置**（数据区写既遂） |

4 类里 3 类（外发、危险销毁、越权写数据区）严格满足两条标准，应归步内前置；凭证泄露需拆「本地写」与「外发携带」两半，前者可归步收尾、后者归步内前置。

### 5.2 总体结论：**建议立项。方向：拦截逻辑复用已有 CommandGate（provider 无关），执法面分 provider 落——claude 走权限/沙箱，codex/kimi/opencode 走原生 hook**

理由：

- **需求真实**：有证据支撑——外发（#83513 等 4 个一手 issue + 本仓 `c23d5776`）、危险销毁（本仓 2 起误删 + The Guardian 生产库删除）、越权写（#57847 + 本仓 `bypassPermissions` 机制前提）。既遂不可纠损害真实存在（含 1.03 亿 token 旁证）。
- **拦截逻辑不用从零造**：CommandGate 黑名单已在 `harness/src/gates/command.ts` 实现、已在 dev 侧 claude 以 PreToolUse hook 跑通。缺的是**推广到 spawn 侧 + 按 provider 选可用执法面**；claude 原生 hook 在 `--print` 下不可用（§3.1），所以 claude 不能指望 hook，其余三家可用原生 hook（§3.2–3.4）。

### 5.3 实现票范围建议（只建议，不设计）

- **第一优先级（P0，claude = 默认 provider，先解它的执法面）**：**实测 claude `--print` 下 `permissions.deny`（权限系统）是否仍生效**——权限 deny 与 PreToolUse hook 是两套机制，deny 不依赖 hook，很可能在非交互下仍拦（这是决定 claude 执法面形态的第一问）。若 deny 生效 → 把 `permissions.deny`（rm -rf / push --force / reset --hard / 越界路径）从仓库级 `.claude/settings.json` 推广到 worktree `.claude/settings.json`（`worktree-resolver.propagateHarnessConfig`）；若 deny 也失效 → claude 需在 spawn 层包命令代理/沙箱。**不要**给 claude 写 PreToolUse hook（`--print` 下不触发，写了也白写）。
- **第二优先级（P1，provider 原生 hook 作执法面）**：codex（`exec --json` 已证实可用，且支持项目级 `.codex/hooks.json`，适合 per-worktree 隔离）+ kimi（`-p` 已实证可用，但只有全局 `~/.kimi-code/config.toml`，多 WU 隔离要处理）——把 CommandGate 生成为其 hook 配置；opencode 插件（throw 阻断，但 batch 盲点未定论 + 插件是代码文件，排后）。
- **明确不做**：不引入 registry `preToolHook` 布尔 capability（误导，见 §4）；不把步收尾 checker（#82/#129）并进本票。

### 5.4 provider 优先级建议

1. **claude**（studio 默认 provider，但原生 hook 不可用）：先验「`permissions.deny` 在 `--print` 下是否仍拦得住」——这是决定 claude 执法面形态的第一问（权限 deny 与 hook 是两套机制，deny 可能在非交互下仍生效）。若 deny 也失效，claude 需在 spawn 层包命令代理/沙箱。
2. **kimi**：已本机实证 `-p` 下 PreToolUse exit 2 阻断，是「原生 hook 执法面」里落地成本最低、已验的一个；但 kimi 无项目级 hooks（只有 `~/.kimi-code/config.toml` 全局），多 WU 隔离需注意。
3. **codex**：`exec --json` 源码+测试证实 hooks 生效，且支持**项目级** `.codex/hooks.json`（适合 per-worktree 隔离），是「per-provider hook 生成器」的首选对象。
4. **opencode**：机制可用但 batch 盲点 + 插件需写 `.opencode/plugin/*.ts`（代码文件，生成成本高于纯配置），排后。

## 6. 沉淀清单（exploration-sediment 分流）

本票为纯调研、只新增 1 个 md，未改任何源码，故「代码旁 CONTEXT.md」不写（无 diff 可对照，且调研结论的持久载体就是本笔记本身）。逐条过：

| 发现 | 落点 | 决定 |
|------|------|------|
| spawn 路径 worktree `.claude/settings.json` 只有 bypassPermissions + mcpServers，无 deny/PreToolUse；仓库级 settings 的 CommandGate hook 不覆盖 executor | `packages/studio-agent/CONTEXT.md` 或 worktree-resolver CONTEXT「注意事项」 | **不写**（本票不改代码；且这是「实现票」的动工前提，届时随实现一并沉淀，避免现在写、实现时重复） |
| claude `--print` 下 PreToolUse 不触发（not_planned） | 同上 | **不写**（同上，且已写入本笔记，调研票的持久载体） |
| 误删/凭证泄露/token-burn 事故证据 | knowledge-extraction（知识库） | **不写**（事故已各自有 git commit / docs/issues/ 落档，非本票新发现） |
| 一次性会话数据（issue 编号、调研过程） | — | 不沉淀 |

即：本票**零条**写入 CONTEXT.md/知识库，理由——纯调研不改代码、结论已固化在本笔记；涉及实现的耐久事实（spawn 配置推广）留给未来实现票在改代码时按 skill 一并沉淀。

## 参考来源

现状零接线（源码）：

- `apps/api/src/modules/mcp/safety.tools.ts`（checkConstraint/checkGuardrail/getSandboxLevel）
- `apps/api/src/modules/mcp/tools.ts`（allTools 注册、executeTool）
- `apps/api/src/modules/harness/guards.routes.ts`（check-input/check-output）
- `packages/studio-shared/src/harness/hooks/agent.hooks.ts`、`config.ts`
- `packages/studio-agent/src/services/runner-execution.ts`、`worktree-resolver.ts`
- `packages/studio-shared/src/providers.ts`
- `harness/src/gates/command.ts`（/root/projects/harness）
- 本机 `~/.claude/settings.json`、`/root/projects/studio/.claude/settings.json`、`~/.codex/config.toml`

事故证据：

- commit `c23d5776`（discord token 明文落日志）、`2352a87b`（恢复误删 A 类代码）、`008912d`+`5e67bf92`（companies 误删重建）
- `docs/issues/2026-08-03-unattended-token-burn.md`
- `docs/sdd/2026-07-system-llm-migration/requirement.md`（settings-deepseek.json 明文 key）
- `~/.studio/knowledge/.archive/pipeline-skills/tool-risk.md`、`pitfall-PIT-019.md`

外部一手来源：

- https://github.com/anthropics/claude-code/issues/83513 （git push 触发未授权生产部署）
- https://github.com/anthropics/claude-code/issues/58079 、/67060 、/69156 （无视禁止 push/不可逆 git 操作）
- https://github.com/anthropics/claude-code/issues/57847 （worktree 子代理越界写父 checkout）
- https://github.com/anthropics/claude-code/issues/20063 、/30143 、/33343 、/36071 、/40506 （`--print` 下 PreToolUse 不触发，not_planned）
- https://github.com/anomalyco/opencode/issues/5894 （tool.execute.before 绕过，真实盲点=batch）
- https://github.com/anomalyco/opencode/issues/13524 （集中化 tool plugin hooks，auto-closed 无修复确认）
- https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/pre_tool_use.rs （exit code/阻断语义）
- https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/hooks.rs （exec 模式阻断端到端测试）
- https://github.com/openai/codex/releases/tag/rust-v0.117.0 、/rust-v0.114.0 （codex hooks 版本）
- https://moonshotai.github.io/kimi-code/en/customization/hooks.html （kimi hooks 文档）
- https://github.com/MoonshotAI/kimi-code （kimi-code 仓库，票内 moonshotai/kimi-cli 需修正）

外部二手来源（新闻/行业报告，非一手）：

- https://www.theguardian.com/technology/2026/apr/29/claude-ai-deletes-firm-database
- https://zhidx.com/p/560458.html （Gemini 误删 28745 行，编译自 Reddit）
- https://www.helpnetsecurity.com/2026/04/14/gitguardian-ai-agents-credentials-leak/ （GitGuardian 29M 泄露）
- https://lyrie.ai/research/research/2026-05-10-03-deepdive-comment-and-control-ai-agent-cicd-credential-theft
