# Studio Agent 工作区指南

## 可用 Skills（索引）
- **arch-review-skill** — 对照 arch-patterns 知识库检查架构文档的概念完整性和覆盖度，识别 P0/P1 缺口。
- **code-review** — 实现完成且测试通过后，对代码执行多维度质量审查（AC 覆盖、质量、架构一致性、安全、边界）。
- **dead-code-removal** — 彻底清理已废弃的代码概念：跨 schema、后端、前端、packages 全链路删除。
- **design-analyst** — 把模糊需求变成结构化设计文档（方案对比、AC 定义、风险评估），或对系统/架构/方案做评估分析。
- **doc-manager-skill** — 文档状态管理：保存进度到 memory、维护文档格式、更新 roadmap Phase、同步 spec/SDD status。
- **knowledge-extraction** — 从近期工作产物中提取可复用知识，去重后写入知识库（Loop 自动触发，也支持用户请求）。
- **knowledge-quality-skill** — 审查知识库条目的语义质量：内容完整性、价值、跨条目矛盾、引用存活、语义重复。
- **knowledge-synthesis-skill** — 从时间窗口的知识集合中产出高阶洞察：语义模式检测与经验教训综合（Loop 自动触发）。
- **migration-execution-skill** — 执行大规模、跨文件的代码库增量迁移（Round 分解 → 转换 → 验证 → 级联修复）。
- **parallel-execution** — 多个独立任务并行执行：为每个任务分配独立 agent，收集结果并汇总汇报。
- **sdd-review-skill** — 对 requirement.md、design.md、task.md 执行 SDD 质量审查与 AC Group 验证。
- **spec-review-skill** — 审查 docs/specs/ 中 spec 文档的质量、状态准确性与 SDD 就绪度。
- **task-planner** — 把设计文档转化为可执行的 SDD 三层文档（requirement.md + design.md + task.md）。
- **tdd-implement** — 读取 SDD 按 TDD 实现代码：先写 FAIL 测试（RED），再实现让测试通过（GREEN）。
- **test-diagnosis** — 测试失败时诊断根因：区分环境问题、依赖问题、代码问题三层，提供系统化 fallback 排查。

各 skill 全文位于 `.studio/skills/<name>/SKILL.md`，与任务相关时按需阅读。

## SDD 落盘要求
- 产出设计文档时：写 `docs/sdd/<slug>/requirement.md`、`docs/sdd/<slug>/design.md`、`docs/sdd/<slug>/task.md`。
- 并在 `docs/sdd/_index.md` 登记该 slug（标题、状态、关联 REQ/任务）。

<!-- AUTO-GENERATED:modules -->
## 模块索引

> 本区段由 `pnpm gen:agents-md`（scripts/gen-agents-md.mjs）生成，请勿手改；
> 新增/变更模块后重跑该命令。CI 门禁（doc_dir_check）校验本表与目录双向一致。

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
| `apps/api/src/modules/llm` | 提供 LLM（大语言模型）配置管理、统一代理接口和意图分析功能。包括多 scope（orchestrator、agent 等）配置的 CRUD 与解析（从 UI 配置与环境变量动态合并）、对下游 Chat 请求的代理转发（/api/v... |
| `apps/api/src/modules/mcp` | MCP（Model Context Protocol）模块 — 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。 |
| `apps/api/src/modules/monitoring` | 负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。 |
| `apps/api/src/modules/notifications` | 提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。 |
| `apps/api/src/modules/outbound-notify` | 本模块提供基于 Discord 的通知发送服务，支持多种任务与会议相关通知类型。内部封装了对 discordNotifier 的调用，并通过 eventStore 将通知事件发布到消息总线。还暴露 HTTP 路由供内部模块通过 POS... |
| `apps/api/src/modules/outputs` | 负责执行结果产出文档的存储和检索。通过文件系统持久化文档内容，并利用 EventStore 维护索引，提供 HTTP API 供外部查询某一执行的所有产出文档。 |
| `apps/api/src/modules/pmo` | 项目管理办公室（PMO）模块，负责 OKR（目标与关键结果）管理与项目管理（项目 CRUD、PMO 号自动生成），并提供 REST API 路由。同时包含已停用的 OKR 异常检测功能（默认不启用）。 |
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
| `packages/studio-monitor` | 监控 Agent 健康状态，定时检查任务超时、心跳及僵尸任务，提供启动和停止监控的接口，确保任务运行的稳定性。 |
| `packages/studio-notification` | 本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记和 CLI 操作。CLI 部分提供模拟通知的发送、列表、标记功能，服务层基于 FileStore 实现持久化通知管理。 |
| `packages/studio-shared` | 跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-... |
| `packages/studio-skill` | 本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）、以及基于文本匹配的意图路由。为 Agent prompt 注入可加载的能力单元。 |
| `packages/studio-spec` | 本目录提供 Spec 的验证、变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。它整合三层验证（架构、API、验收），支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。 |
| `packages/studio-task` | 提供任务队列管理（TaskQueue）和任务执行器（TaskWorker），以及任务相关的 CLI 命令（查看队列、运行、重试、清理）和类型定义，支撑 studio 的任务调度与执行能力。 |
<!-- /AUTO-GENERATED:modules -->
