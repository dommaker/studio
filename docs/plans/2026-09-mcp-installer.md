# 对外只读 MCP 一键安装器（studio mcp install）

> 日期：2026-09-16。状态：设计提案，待评审。

## 背景与现状

studio 的 MCP server（`apps/api/src/modules/mcp/`）现在只服务自己 spawn 出去的 agent：worktree-resolver 往 WU worktree 写 `.claude/settings.json`，注入 `mcpServers.studio = { type: 'sse', url: STUDIO_MCP_URL }` 回连本机 API（`packages/studio-agent/src/services/worktree-resolver.ts:231-249`）。用户在普通终端开的 claude/kimi 会话够不到 studio 数据，只能开 web UI 看。

MCP 面现状（已读码核实）：

- `tools.ts` 门面聚合 19 个 tools，分域文件 pmo(3)/task(5)/economy(1)/spec(4)/safety(1)/system(2)/devops(1)/skill(1)/workunit(1)。其中读操作约 10 个（listProjects/getProjectStatus/getTaskBoard/getTaskStats/getBalance/getSpecStatus/listSpecs/checkConstraint/systemHealth/loadSkill），其余为写。
- **item 假设的「查 workunit / 读频道消息 / 查 requirement」MCP tool 不存在**——workunit 域只有 createWorkUnit（写）。底层读能力都在：`WorkUnitService.getById/list`、`RequirementService.get/list/getChain`、channels 的 `readMessagesTail/queryMessagesPage`，缺的是 MCP 包装。
- `server.ts` 是 JSON-RPC 处理（initialize/tools/list/tools/call），`handleStdio()` 存在但**无任何 bin 接线，当前是死代码**。
- `routes.ts` transport：SSE（GET `/sse` + POST `/messages`）+ 完整 JSON-RPC POST `/`，三者均挂 `requireLocalhost`（拒绝带 X-Forwarded-For/CF-Connecting-IP 的请求，防同机反代穿透）；`POST /tools/:name` 与 `/admin/*` 挂 requireAuth+requireAdmin。
- 权限两层：HTTP 面鉴权（上述中间件）+ agent 角色 RBAC（`permission.service.ts`，FileStore 存 `mcp-permissions.json`，**default-deny**，seed 给 admin/executor 等 8 个系统角色默认放行、publishPackage 仅 admin/deploy）。tools/call 的 roleId 自声明、缺省落 `executor`（executor seed 全允许）——**即任何本机回环调用方今天就能调写工具**，对外必须收口。
- 审计现状：`executeTool` 每次调用异步落 `mcp-audit-logs.jsonl`，不动。
- CLI：`studio mcp` 已存在于 `studio-cli.ts` → `data.ts studioMcp()`，现只有 `tools|health` 两个子命令。
- 端口口径不一致（顺带发现）：CLI 默认 `PORT||3001`，worktree-resolver 默认 `STUDIO_MCP_URL||http://localhost:13101/...`。install 时 URL 来源要定。

## 目标与非目标

目标：用户在任意终端的 agent 会话里 `studio mcp install claude` 一条命令后，该 agent 直接查 studio 数据（WU/频道消息/REQ/skill），不开 web UI。

非目标：对外暴露写操作；远程（非本机）访问；改内部 agent 现有 RBAC/审计/回连链路；web UI 任何改动。

## 方案

### 设计决策（读码后定论）

**D1 标记机制 = tool 定义加 `exposure` 字段，不维护外挂白名单。** `RegisteredTool`（tool-registry.ts）已有 `riskLevel` 等元数据先例，新增 `exposure?: 'internal' | 'external'`（缺省 `internal`，default-deny 同构）。理由：标记与定义同文件同评审，新增 tool 默认不外放；白名单数组会漂。`getSchemas(audience)` 按 audience 过滤；`tools/list` 外部入口只回 `external` 子集。

**D2 外部入口 = 独立路由前缀，钉死角色。** 新增 `/api/v1/mcp/external/sse` + `/api/v1/mcp/external/messages`，挂 `requireLocalhost`，**强制 roleId='external'（忽略自声明）**，tools/list 只出 external 子集。RBAC seed 新增角色 `external`：仅 exposure=external 的 tool allowed=true，其余 default-deny。写工具到外部面有三层堵：tools/list 不见 → role 无权限 → default-deny。内部 `/sse` `/messages` `/` 路径一行不动。

**D3 连接形态 = SSE 直连优先，不做自研 stdio bridge。** studio 本就是常驻本机服务，SSE 零新增进程、零新依赖，内部 worktree agent 已实测走通同一路径；`handleStdio()` 保持死代码不接（接了就要维护 stdin 生命周期、进程驻留，YAGNI）。某 agent CLI 不支持 SSE transport 时，配置里写 `npx mcp-remote <url>` 桥（成熟外部件，非自研）——是否必要由各 agent 核查结果定（见开放问题 Q2）。

**D4 不要 token。** 威胁模型 = 同机其他进程。token 须明文写进 agent 配置文件，同用户可读，对本机威胁无实际增益，只加摩擦。防线 = requireLocalhost（含转发头拒绝）+ 只读子集 + RBAC default-deny。未来若要远程访问再议 token（届时是另一张票）。

### 阶段划分

**P1 — 只读子集 + 外部入口（可独立交付/回滚）**
触及：`tool-registry.ts`（RegisteredTool 加 exposure、getSchemas 加 audience 过滤）、各域 `*.tools.ts`（选中的读 tool 标 `exposure:'external'`）、`permission.service.ts`（seed 加 external 角色）、`routes.ts`（加 /external 前缀两路由）、`server.ts`（tools/call 支持入口侧钉角色，最小改）、测试。
P1 外放子集（现有 10 读里选 8）：`listProjects` `getProjectStatus` `getTaskBoard` `getTaskStats` `getSpecStatus` `listSpecs` `systemHealth` `loadSkill`。**不外放** `getBalance`（经济是内部激励概念）与 `checkConstraint`（内部治理面），见 Q1。
回滚 = revert；external 角色 seed 记录残留无害。

**P2 — 补齐缺失读 tools（可独立交付/回滚）**
新增 read-only tools，全部 `exposure:'external'`：
- `getWorkUnit(id)` / `listWorkUnits(filter)` — 包 `WorkUnitService.getById/list`
- `getChannelMessages(channelId, limit?)` — 包 channels 读面（热层 tail，冷层穿透分页是否暴露实施时定，先热层）
- `getRequirement(id)` / `listRequirements(filter?)` — 包 `RequirementService.get/list`
触及：`workunit.tools.ts`、新建 `channel.tools.ts` `requirement.tools.ts`、`tools.ts` 门面展开、测试。写操作（createWorkUnit 等）维持 internal。

**P3 — `studio mcp install <agent>`（可独立交付/回滚）**
`data.ts studioMcp()` 加子命令：`install <agent> [--print] [--uninstall]`。
- 行为：幂等合并写目标 agent 配置文件的 MCP 段（只动 `studio` 一个 key，保留既有字段，写前备份 `<file>.bak`）；`--print` 干跑输出将写入的 JSON 片段不落盘；`--uninstall` 只删 `studio` key。URL 默认 `http://localhost:<PORT>/api/v1/mcp/external/sse`，`--url` 可覆盖。
- 支持 agent 首批：`claude` `kimi` `codex` `opencode`。per-agent 一个适配器（目标文件路径 + 格式 + 合入键位），claude 先行，其余三个随核查结果跟进。
- 触及：`apps/api/src/cli/data.ts`（或新 `cli/mcp-install.ts` 被 data.ts 调）、测试、`docs/cli-reference.md`、`mcp/CONTEXT.md`。

### 实施时核查项（禁止凭记忆写死，逐一验证后落码）

1. 各 agent 用户级 MCP 配置文件路径/格式/合入键位：claude（`~/.claude.json` 的 `mcpServers`？还是 `claude mcp add` CLI 包装）、kimi（`~/.kimi-code/config.toml`？）、codex（`~/.codex/config.toml` `[mcp_servers.*]`？）、opencode（`~/.config/opencode/opencode.json` `mcp` 段？）——全部以各 CLI 当季官方文档 + 本机实测为准。
2. 各 agent 是否支持 SSE transport；不支持的确认 `mcp-remote` 桥可行（D3）。
3. install 时端口来源：PORT env / `studio status` 探测 / 固定默认——现状 3001 与 13101 两口径不一致（背景节），按 Q3 已决策结论执行（探测 3001 health，不通则报错提示 `--url`）。
4. claude 用户级 scope 与项目级 `.mcp.json` 的取舍（install 写哪一级）。

## 验收标准（AC）

- [ ] AC1：`GET /api/v1/mcp/external/sse` + messages 通路可用，`tools/list` 只返回 exposure=external 的 tool，不含任何写 tool。
- [ ] AC2：经外部入口 `tools/call` 调写 tool（如 createWorkUnit）返回 permission denied；自声明 `roleId:'admin'` 无效。
- [ ] AC3：内部入口（`/sse` `/messages` `/`）行为与现状完全一致（既有测试不改动全绿）。
- [ ] AC4：`getWorkUnit`/`getChannelMessages`/`getRequirement` 返回与对应 REST/服务层一致的数据。
- [ ] AC5：`studio mcp install claude --print` 输出配置片段且不落盘；不带 `--print` 写入后该 agent 新会话可见 studio tools；重复 install 幂等；`--uninstall` 后配置复原（既有字段无损）。
- [ ] AC6：外部入口非回环（带 X-Forwarded-For）请求被拒。
- [ ] AC7：新代码全部带测试；`vitest run --changed origin/master` + typecheck 绿。

## 风险与边界

- **roleId 自声明模型的既有口子**（executor 全允许）不在本票收口范围——本票用独立入口钉角色绕开它；内部入口现状不动。
- SSE 长连接占用：外部入口与内部同限频（mcpRateLimit 回环 skip 现状），本机单用户场景风险低。
- 配置文件写坏：写前 `.bak` 备份 + JSON parse 校验，parse 失败拒写。
- 公开仓库脱敏：install 代码与文档不出现任何内部主机/路径，URL 只写 localhost。

## 不做清单

- 不做写操作外放（含「申请写权限」流程）。
- 不做 token/OAuth 层。
- 不接 `handleStdio()`，不自研 stdio bridge。
- 不改 executor 等内部角色 seed、不改审计格式。
- 不做远程访问、不做多机。
- 不动 `getBalance`/`checkConstraint` 以外其余 internal tool 的任何定义。

## 开放问题（2026-09-16 人审全部决策，以下为结论）

- **Q1 外放边界**：`getBalance`（economy）与 `checkConstraint`（safety）是否外放？**已决策：均不外放**（内部激励/治理概念，外部 agent 无消费场景）。
- **Q2 某 agent 不支持 SSE 时**：**已决策：不引入 `mcp-remote` 桥**，第一版只为支持 SSE 的 agent 出 install，其余报错提示。
- **Q3 install 默认 URL 的端口**：CLI 默认 3001 vs worktree-resolver 默认 13101 不一致。**已决策：先探测 `http://localhost:3001/api/v1/mcp/health`，通了用 3001；不通报错并提示 `--url` 显式传入，不顺延猜测其他端口。**
- **Q4 claude 写用户级还是项目级**：**已决策：写用户级 `~/.claude.json`**（理由：studio 是机器级服务），项目级 `.mcp.json` 留给后续 `--project` flag。
