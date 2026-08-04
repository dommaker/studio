# AGENTS.md

> 本文件由 `harness sync-docs --agents` 自动生成，请勿手改。`<!-- PRESERVE:名称 -->` 与 `<!-- /PRESERVE:名称 -->` 之间的内容在重新生成时原样保留。内容漂移时重新运行该命令更新。

## 项目简介

**@dommaker/studio** — Agent Studio - Multi-Agent Collaboration Platform

## 目录结构

| 目录 | 说明 |
|------|------|
| `.github/` | CI/CD 配置 |
| `.harness/` | harness 配置与运行时状态 |
| `apps/` | monorepo 应用：api、web |
| `bin/` | 可执行入口/脚本 |
| `docs/` | 项目文档 |
| `node-compile-cache/` | — |
| `packages/` | monorepo 共享包：studio-agent、studio-audit、studio-capability、studio-notification、studio-shared、studio-skill、studio-spec |
| `scripts/` | 工具脚本 |
| `tests/` | 测试 |

## 常用命令

```bash
pnpm dev  # 启动开发环境
pnpm build  # 构建
pnpm test  # 运行测试
pnpm test:e2e  # 端到端测试
pnpm typecheck  # 类型检查
pnpm lint  # 代码检查
pnpm start  # 启动生产服务
```

## 约束与治理

- 治理配置：`.harness/config.yml`（preset: standard）
- 约束清单：`CLAUDE.md` Governance Rules 块（Iron Laws 11 条、Guidelines 25 条）

## 知识入口

- `.harness/knowledge/`：项目知识库，用 `harness knowledge` 查询
- 各源码目录的 `CONTEXT.md` 是权威模块文档（现有 44 个），改动代码时同步更新

<!-- PRESERVE:modules -->
<!-- AUTO-GENERATED:modules -->
## 模块索引

> 本区段由 `pnpm gen:agents-md`（scripts/gen-agents-md.mjs）生成，请勿手改；
> 新增/变更模块后重跑该命令。AGENTS.md 全文（含 harness 生成的导读部分）用 `pnpm agents-md:sync` 重建，勿手改本文件。

| 目录 | 说明 |
|------|------|
| `apps/api/src/modules/admin` | 提供 REST API 端点检查 CLAUDE.md 和 CAPABILITIES.md 的文档新鲜度，包括文件是否存在、最近修改时间、harness 约束检查结果，用于监控文档同步状态。 |
| `apps/api/src/modules/agent-configs` | 提供 Agent 配置管理的 REST 路由，支持 Agent 的增删改查以及版本快照（HZ-024, HZ-025）。 |
| `apps/api/src/modules/agents` | 负责管理 Agent 的配置（profile）、运行实例（instance）、决策循环（loop）以及内部审计 Agent（Auditor）等核心编排逻辑。提供 REST API 进行 CRUD 操作，并通过事件驱动机制实现 Agen... |
| `apps/api/src/modules/audit` | 将 EventBus 中的审计事件（events:audit）持久化到 KnowledgeStore，提供启动和停止订阅控制，确保每条事件以 guideline 类型存储，并记录错误日志。 |
| `apps/api/src/modules/audit-logs` | 提供审计日志的查询与统计 API 端点，支持按用户、角色、公司、操作类型、资源、状态、时间范围等条件过滤，并支持分页查询和统计汇总。 |
| `apps/api/src/modules/auth` | 负责 API 用户认证与会话管理，包括注册、登录、Guest Session 创建、认证状态查询及 JWT 令牌管理。同时集成 OAuth 认证流程（参见 oauth.routes.ts 与 oauth.service.ts）和邮件验... |
| `apps/api/src/modules/builtin-tools` | 提供一组内置工具（文件操作、搜索、执行、通信）的元数据定义与 RESTful 路由，供上层服务注册和调用。工具列表静态注册在 routes.ts 中，每个工具包含名称、描述、分类、输入 schema 与启用状态。 |
| `apps/api/src/modules/capabilities` | 提供能力注册表的读取与 API 暴露，包括从文件系统加载工具/技能定义，并通过 Express 路由对外提供服务。同时定义能力类型（Capability）和注册表（Registry）接口，支持缓存与阶段（Stage）识别。 |
| `apps/api/src/modules/channels` | Channel 驱动管线入口：@Analyst 触发 → RequirementsDoc 生成 → Goal 创建 → 执行管线。 |
| `apps/api/src/modules/companies` | 公司（Company）记录的 CRUD REST API，FileStore 文件存储（~/.studio/data/companies/*.json），不依赖数据库。前端 PMO 页、Settings 页、useCompanyId... |
| `apps/api/src/modules/deploy` | （缺少 CONTEXT.md，请补充） |
| `apps/api/src/modules/dingtalk` | 处理钉钉机器人交互回调，包括 ActionCard 按钮点击的健康检查和操作忽略提示。当前 Meeting 模块已移除，按钮点击仅返回占位响应。 |
| `apps/api/src/modules/discord` | 处理 Discord 集成，包括命令行 (studio run) 和 Discord 斜杠命令 (/studio run) 共享的命令运行逻辑，以及 Discord 交互端点（按钮点击回调）的路由处理。 |
| `apps/api/src/modules/environments` | 提供环境管理（Environment Manager）的 CRUD REST API，包括环境列表、详情、创建、更新和删除（虽然摘要未显示更新和删除，但根据描述应有，但以源码为准，源码只显示了GET列表、GET详情、POST创建，可能... |
| `apps/api/src/modules/events` | 提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。 |
| `apps/api/src/modules/evolution` | E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness... |
| `apps/api/src/modules/executions` | 提供执行（execution）相关的 REST API 路由，当前仅包含获取执行列表（GET /）。基于本地 JSONL 文件和 tasks 目录的 FileStore 实现，不依赖已删除的数据库。此模块为遗留接口（LEGACY su... |
| `apps/api/src/modules/harness` | Harness 监控与治理 API（FL-029 / T-015）：轨迹采集分析、约束生命周期、 |
| `apps/api/src/modules/knowledge` | 知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。 |
| `apps/api/src/modules/lark` | 处理飞书机器人回调事件，包括 URL 验证（首次配置）、卡片按钮点击事件（card.action.trigger）以及其他未处理事件。提供健康检查端点。 |
| `apps/api/src/modules/mcp` | MCP（Model Context Protocol）模块 — 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。 |
| `apps/api/src/modules/monitoring` | 负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。 |
| `apps/api/src/modules/notifications` | 提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。 |
| `apps/api/src/modules/outbound-notify` | 本模块提供基于 Discord 的通知发送服务，支持多种任务与会议相关通知类型。内部封装了对 discordNotifier 的调用，并通过 eventStore 将通知事件发布到消息总线。还暴露 HTTP 路由供内部模块通过 POS... |
| `apps/api/src/modules/outputs` | 负责执行结果产出文档的存储和检索。通过文件系统持久化文档内容，并利用 EventStore 维护索引，提供 HTTP API 供外部查询某一执行的所有产出文档。 |
| `apps/api/src/modules/pmo` | 项目管理办公室（PMO）模块：OKR 管理 + 项目管理（CRUD、统一编号 PMO-<n> 自动生成）+ 交付守卫。PMO 是链条的脊椎（2026-07-28 分析文档 §4.5）：id = 分支名（gitBranch 默认 = p... |
| `apps/api/src/modules/projects` | Project Discovery（AC-D1 + AC-D3）：发现已注册的工程（repo）信息并对外提供查询 API，供频道默认工程、WorkUnit 工程绑定等流程使用。 |
| `apps/api/src/modules/requirements` | REQ 需求编号体系（vision §5.3）：一个需求（REQ-<序号>）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。 |
| `apps/api/src/modules/runtime-config` | 提供 TaskWorker 运行时配置的 HTTP API（GET/POST），配置读写基于 EventStore 实现持久化存储，并返回默认配置或存储中的配置。 |
| `apps/api/src/modules/sdd` | SDD（变更规格）文档新鲜度服务：检测 docs/sdd/ 规格文档与代码演进的漂移。 |
| `apps/api/src/modules/shared` | apps/api 各模块共享的纯函数工具，不承载业务状态。 |
| `apps/api/src/modules/skills` | skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、提案存储（ProposalStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（ski... |
| `apps/api/src/modules/spec-reviews` | 该模块提供 Spec 审查相关的 API 路由和后端服务，包括创建审查、查询审查、获取详情、提交审批等核心功能，支持绕过审批操作，并触发通知。数据持久化使用 FileStore（文件存储）替代原有 Prisma 依赖。 |
| `apps/api/src/modules/specs` | 提供 Specs 模块的 HTTP API 路由，包括变更分析、变更历史查询和门禁验证（待实现）。遵循 SP-002 变更分级流程，通过调用外部 SDK 中的服务处理 Spec 变更相关的业务逻辑。 |
| `apps/api/src/modules/triage` | 实现错误的分类（triage）与严重度评估，提供策略路由（auto_retry / manual_fix / escalate / ignore），支持开发者错误和系统级事件的分类。 |
| `apps/api/src/modules/triggers` | Trigger 子系统（AS-026，3.28c-4）：SCHEDULE（cron）+ EVENT（EventBus）两类条件的触发器调度与持久化，动作包括 CREATE WorkUnit / UPDATE / EXECUTE。系统默... |
| `apps/api/src/modules/wiki` | 本目录实现 Wiki 文档的查询与更新 API，基于 SDD（Software Design Document）文件读取，提供列表搜索、图谱构建、文档详情与内容更新功能。所有读取操作均为 SDD-only（不依赖数据库），符合 B2-... |
| `apps/api/src/modules/workspaces` | 远程 Workspace 注册/心跳、Token 管理、WS 网关（Daemon 通信）、目录发现代理、任务 claim/事件回报、GC 清理。 |
| `apps/api/src/modules/workunit` | WorkUnit 核心域（AS-025 §3.28c-1, §5.16）：任务单元的 CRUD、认领（Claim）与状态机；F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。 |
| `packages/studio-agent` | Sub-agent 的完整生命周期管理：创建隔离 worktree → spawn Claude Code → session loop 监控 → 完成判定。 |
| `packages/studio-audit` | 提供审计日志的记录、查询、导出和链式完整性验证功能。支持通过 AuditService 进行持久化日志操作，通过 CLI 模块进行离线查询和导出，并通过 audit-chain 实现基于哈希链的防篡改审计记录。 |
| `packages/studio-capability` | 本目录负责能力管理（CapabilityService）与公司 MCP 资源池管理（company-mcp-pool）。CapabilityService 提供能力的 CRUD、同步、统计，并基于 FileStore JSON 文件存... |
| `packages/studio-notification` | 本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记和 CLI 操作。CLI 部分提供模拟通知的发送、列表、标记功能，服务层基于 FileStore 实现持久化通知管理。 |
| `packages/studio-shared` | 跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-... |
| `packages/studio-skill` | 本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）、以及基于文本匹配的意图路由。为 Agent prompt 注入可加载的能力单元。 |
| `packages/studio-spec` | 本目录提供 Spec 的验证、变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。它整合三层验证（架构、API、验收），支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。 |
<!-- /AUTO-GENERATED:modules -->
<!-- /PRESERVE:modules -->

<!-- PRESERVE:release-flow -->
## 发布流程（代码写完后怎么上线）

**唯一权威说明：`/root/projects/studio-config/SHIP.md`**。双轨制（2026-08-04 起）：

- **日常快速部署（平时走这条）：`studio-deploy-quick`**（`~/projects/studio-config/bin/`）——本地校验（vitest --changed + harness check + sync-docs）+ 直部署生产 checkout `/root/projects/studio-prod`，3-5min 看效果，不走 PR/CI；写 `state.json mode=quick` 阻止 cron auto-deploy 覆盖；健康检查失败自动回滚 PREV（本地分支保留，不丢代码）；完成后异步 push 当前分支到 GitHub 备份。
- **批次同步：`studio-ship`**——攒一批后手动跑：清 `mode=quick` → PR → CI → auto-merge → 盯到合并；合并后 cron 每分钟 `auto-deploy.sh` 在 studio-prod（git worktree，与开发仓解耦）部署 origin/master → 健康检查 → 失败自动回滚。

- 部署状态：`studio-ship deploy-state`（state.json）或 PushPlus 微信告警
- 部署日志：`/var/log/studio-deploy.log`
- 本仓的任何分支/脏树/本地领先状态都**不影响**部署（2026-07-29 起）
- **分批提交（用户要求，2026-08-04 起）**：长任务开发中按逻辑批次及时 `git commit`（feat/fix/chore/docs 前缀），不攒大批量未提交改动，避免工作丢失；提交落在本地 master 或 feature 分支均可。`studio-deploy-quick` 与 `studio-ship` 均由用户触发，agent 不主动执行、不主动 push。
<!-- /PRESERVE:release-flow -->
