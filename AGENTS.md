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
| `dist-npm/` | — |
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

## 知识入口

- `.harness/knowledge/`：项目知识库，用 `harness knowledge` 查询
- 各源码目录的 `CONTEXT.md` 是权威模块文档（现有 45 个），改动代码时同步更新

<!-- PRESERVE:governance -->
## 治理契约

> 本段手写，增删改走段末「治理变更流程」。依据：docs/adr/2026-08-21-agent-docs-three-kinds.md（内容三分）+ 2026-08-21-agent-docs-placement-model.md（落点模型），2026-08-21 自 CLAUDE.md 迁入（#300/#303）。

- 数据目录契约：`docs/architecture/data-directory-contract.md` 是 `~/.studio` 数据区布局/可改纪律/变更纪律/版本迁移的唯一正本；布局变更须先修订契约（出处：#570 / docs/plans/2026-09-npm-local-form.md §7.4，治理人闸 2026-09-16 当场通过）。

### 承接约束文本（harness 1.10.0 起手写）

> harness 1.10.0（ADR-0029）关停文本注入层，HARNESS_CONSTRAINTS 注入段（含版本戳与漂移校验）不再生成；
> 以下两条文本由原注入段承接迁入本段（studio#606，治理人闸 2026-09-20 当场通过）。
> `no_completion_without_verification` 的 checker 机制本体仍在 harness 机制面，此处只承接文本。

- **no_completion_without_verification**（harness 内置 checker，severity=error）：在声明任务完成前，必须重新运行新鲜的验证命令——受改动影响的测试（vitest run --changed origin/master）+ type check，使用新鲜的输出作为完成证据，不得复用旧结果。全量测试由 CI / 发布流程兜底。（文本原采用 .harness/custom-constraints.yml 的 studio 覆写口径——该文件已随 ADR-0029/#606 退役、仓内运行时通道随 #617 拆除；2026-08-14 决策；#606 迁入，2026-09-20）
- **public_repo_sanitization**（纯文本治理约束，无 checker，**违反即停——非建议**）：本仓为公开仓库，任何写入内容（代码、文档、注释、测试数据、commit message）提交前必须脱敏自查：禁止写入凭证/密钥、内部基础设施信息（主机名、内网域名、IP、部署路径、运维流程细节）、私有仓库内容、个人隐私数据。从私有配置仓复制配置或文档时必须重新逐行审查。规则文本本身也不得列举具体敏感值。（出处：2026-08-26 公开仓安全脱敏决策；#606 自 custom-constraints.yml 迁入（该文件已退役、仓内运行时通道随 #617 拆除），2026-09-20。阻断口径承接自旧注入段的 Iron Laws 分级——机制无 checker 不等于可建议性遵守；2026-09-21 治理人闸当场通过）

## 探索结论沉淀

避免重复探索的三条规则：

- **探索前**：先读目标目录的 `CONTEXT.md`（模块级耐久知识散置在各源码目录）+ `docs/plans/` 相关计划，能回答就不再重复探索。
- **探索/实现后**：把新发现的关键事实（数据流、存储布局、调用链、坑）更新到对应源码目录 `CONTEXT.md` 的「核心导出 / 注意事项」。凡启动过调研（explore agent / 多路搜索 / 多文件排查）的任务，收尾必须按 `~/.studio/skills/exploration-sediment/SKILL.md` 的分流清单过一遍，并在交付回复中列出沉淀清单（写了哪几条、其余为何不写）。
- **计划落盘**：非平凡任务的计划一律先写 `docs/plans/YYYY-MM-<slug>.md` 再实施。

## AGENTS.md 维护

- 本文件机器生成部分由 `harness sync-docs --agents` 生成；`AUTO-GENERATED:modules` 段由 `pnpm gen:agents-md`（scripts/gen-agents-md.mjs）维护；统一重建入口 `pnpm agents-md:sync`（先 harness 打底，再组合模块索引段，幂等）。机器生成段禁止手改，过时重新生成。
- 手写内容住 `PRESERVE:*` 段（本段、Agent skills 等），重新生成原样保留；手写段的增删改走治理变更流程。
- CI 的 `harness sync-docs --check --agents` 漂移校验对组合文件有效（模块索引段外层套 `PRESERVE:modules`，2026-07-27 治理决策起 CI 开启 `--agents`）。校验面只覆盖机器生成段：HARNESS_CONSTRAINTS 注入段的版本戳/漂移校验已随 harness 1.10.0（ADR-0029 文本注入层关停）摘除，治理文本由本段手写自证。

## 治理变更流程（#166，2026-08-16）

「改规矩的规矩」——治理内容的增/删/改/弱化一视同仁，均须先过人闸再动手：

- **治理内容清单**：本段（`PRESERVE:governance`）+ 其他手写 PRESERVE 段（如 `PRESERVE:agent-skills`）+ CONTEXT.md 中标「治理变更」的条目（如工单类型词表）。机器可再生的内容（AGENTS.md 生成段、模块索引、CAPABILITIES.md）不在此列——不设审批，过时重新生成，禁止手改。
- **人闸两种情形**：人在会话中 → 改动前摆出「改哪条、为什么」，人确认才动手；无人在场（定时/事件触发） → 禁止直接改，建「待确认」状态的工单等人批准（与工单创建的人闸同一套机制，出处 #126/#130）。
- **留痕**：commit 必带 trailer `Governance-Approved: session`（当场确认）、`Governance-Approved: #<单号>`（走单批准）或 `Governance-Approved: EP-<提案号>`（飞轮提案频道人审——词表扩展，出处：docs/plans/2026-09-flywheel-e1-remediation.md M3.5，2026-09-21 会话当场通过）；条文旁注明出处与日期。
- **执行**：君子协定不拦截；trailer 即合规数据源，`git log --grep Governance-Approved` 可统计合规率，机器化检查留待数据支撑后再议。
- docs/vision-2026.md 是架构宪法：修订须逐条当人面过、全票人审，不走本流程（出处 #81）。

## 发布纪律（公共面）

- 长任务开发中按逻辑批次及时 `git commit`（feat/fix/chore/docs 前缀），不攒大批量未提交改动；提交直落本地 master（不按工单开分支）。
- 部署与发布命令由用户触发：agent 不主动执行部署/发布命令、不主动 push。

## 工单类型 → 方法论索引

工单类型词表见根 `CONTEXT.md`「工单类型」（增删类型 = 治理变更）。agent 按工单类型取默认方法论与产出契约；派单/解锁/打回等流转由机制承载，agent 不见机制、不判前置产出。

| 工单类型 | 默认方法论 | 产出契约 |
|---------|-----------|---------|
| 需求 | requirement-clarify（问清楚，位1 主方法论） | spec 落业务仓 `.studio/specs/`（冻结正本） |
| 决策单 | grilling（开图，网状决策） | 结论记录于工单；需冻结的落 `docs/adr/` |
| spec单 | requirement-clarify 位2 质量门（spec 就绪度） | spec 过质量门，状态回写工单 |
| 任务单 | to-tickets → tdd-implement | 子工单 + RED-GREEN 实现 + Phase commit |
| implement | tdd-implement | 先行测试 + 实现 + Phase commit（实现 commit 引用测试 sha） |
| review | code-review（两轴：契约轴 AC 对照 → 规范轴） | 评审结论回写工单；打回 → 修复单 |
| analysis | research（调研）/ prototype（原型） | 报告落 `.studio/research/` 并回挂来源单；原型 = `prototype/<name>` 一次性分支（不合并、不评审）+ 结论 |
| bug | diagnosing-bugs（诊断→复现→修复→防回归；快速路，不开图不写成文单） | 复现测试先行（FAIL 复现 → 修复 → GREEN）+ 防回归测试随修复同 commit；根因在需求/设计层 → 升级转决策单/开图，诊断事实随工单携带 |

### 不触发场景

- 改一行 bug fix、格式调整、重命名 → 直接改
- 用户说"直接改/直接实现" → 直接改
- 改动 ≤ 1 文件且无 AC → 不走 tdd-implement
- 分析/读代码阶段 → 不触发任何 Skill
<!-- /PRESERVE:governance -->

<!-- PRESERVE:modules -->
<!-- AUTO-GENERATED:modules -->
## 模块索引

> 本区段由 `pnpm gen:agents-md`（scripts/gen-agents-md.mjs）生成，请勿手改；
> 摘要取自各目录 CONTEXT.md 的「职责」节；新增/变更模块后补 CONTEXT.md 并重跑该命令。
> AGENTS.md 全文（含 harness 生成的导读部分）用 `pnpm agents-md:sync` 重建，勿手改本文件。

| 目录 | 说明 |
|------|------|
| `apps/api/src/modules/action-center` | 统一行动中心（#468）：一个端点回答「现在需要我做什么」。GET /api/v1/action-center（requireAuth + requireNotGuest）返回三段：stateItems（状态派生：reply=bloc... |
| `apps/api/src/modules/admin` | 提供 REST API 端点检查 CLAUDE.md 和 CAPABILITIES.md 的文档新鲜度，包括文件是否存在、最近修改时间、harness 约束检查结果，用于监控文档同步状态。 |
| `apps/api/src/modules/agents` | Agent 配置（profile）、运行实例（instance）、决策循环（loop）及内部审计 Agent（Auditor/Monitor/Knowledge/Triage/Ops）编排。REST API CRUD + 事件驱动自动... |
| `apps/api/src/modules/audit-logs` | 提供审计日志的查询与统计 API 端点，支持按用户、角色、公司、操作类型、资源、状态、时间范围等条件过滤，并支持分页查询和统计汇总。 |
| `apps/api/src/modules/auth` | 负责 API 用户认证与会话管理，包括注册、登录、Guest Session 创建、认证状态查询及 JWT 令牌管理。同时集成 OAuth 认证流程（参见 oauth.routes.ts 与 oauth.service.ts）和邮件验... |
| `apps/api/src/modules/builtin-tools` | 提供一组内置工具（文件操作、搜索、执行、通信）的元数据定义与 RESTful 路由，供上层服务注册和调用。工具列表静态注册在 routes.ts 中，每个工具包含名称、描述、分类、输入 schema 与启用状态。 |
| `apps/api/src/modules/capabilities` | 提供能力注册表的读取与 API 暴露，包括从文件系统加载工具/技能定义，并通过 Express 路由对外提供服务。同时定义能力类型（Capability）和注册表（Registry）接口，支持缓存与阶段（Stage）识别。 |
| `apps/api/src/modules/channels` | Channel 域：频道 CRUD/成员/路由表、消息创建与路由（replyTo 线程 / @mention 派单 / 决策12 默认角色）、情境引导建议推导、@文件引用词表、「当前 PMO」派生。 |
| `apps/api/src/modules/companies` | 公司（Company）记录的 CRUD REST API，FileStore 文件存储（~/.studio/data/companies/*.json），不依赖数据库。PMO 的 OKR/项目均以 companyId 作为归属维度。创... |
| `apps/api/src/modules/deploy` | Deploy Webhook：GitHub push 事件触发的自动部署入口（触发式部署，替代每分钟轮询的主通道）。仅接受 push 到 refs/heads/master，202 立即返回后异步触发部署脚本（幂等可重入，脚本内含方向... |
| `apps/api/src/modules/dingtalk` | 处理钉钉机器人交互回调，包括 ActionCard 按钮点击的健康检查和操作忽略提示。当前 Meeting 模块已移除，按钮点击仅返回占位响应。 |
| `apps/api/src/modules/discord` | 处理 Discord 集成，包括命令行 (studio run) 和 Discord 斜杠命令 (/studio run) 共享的命令运行逻辑，以及 Discord 交互端点（按钮点击回调）的路由处理。 |
| `apps/api/src/modules/distill` | 蒸馏主链路：WU done 钩子跑门槛检测（纯确定性计数，零 LLM）-> 命中发 distill_proposal 卡到 #系统 -> approve 后 system-executor 执行蒸馏 -> 产物入库 + 原料 matu... |
| `apps/api/src/modules/events` | 提供全局事件系统：StudioEvent CRUD（G30）、AgentEvent 批量写入（B9-014）、SSE 实时流（HZ-028）、Session 摘要生成（B9-015）。 |
| `apps/api/src/modules/evolution` | E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：从执行 traces/outcomes 中加载信号，生成约束进化提案，经频道人工审核后生效到 harness... |
| `apps/api/src/modules/executions` | 提供执行（execution）相关的 REST API 路由，当前仅包含获取执行列表（GET /）。基于本地 JSONL 文件和 tasks 目录的 FileStore 实现，不依赖已删除的数据库。此模块为遗留接口（LEGACY su... |
| `apps/api/src/modules/harness` | Harness 监控与治理 API（FL-029 / T-015）：轨迹采集分析、约束生命周期、 |
| `apps/api/src/modules/knowledge` | 知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。 |
| `apps/api/src/modules/lark` | 处理飞书机器人回调事件，包括 URL 验证（首次配置）、卡片按钮点击事件（card.action.trigger）以及其他未处理事件。提供健康检查端点。 |
| `apps/api/src/modules/library` | 阅览室（#155 T5）：跨项目 .studio/ 文档面的聚合只读层。缺省遍历全部有 gitRepo 的 PMO 项目，读各仓 .studio/ 下的 specs/、research/、CONTEXT.md + 仓根 docs/ad... |
| `apps/api/src/modules/mcp` | MCP（Model Context Protocol）模块 — 将 Studio 系统能力暴露为 MCP tools，供 Agent 和 UI 共享调用。 |
| `apps/api/src/modules/monitoring` | 负责聚合 Agent Network 的监控指标，包括 Agent 摘要、统计信息、飞轮指标（M1）和封装开销（M2），通过 HTTP 路由对外暴露。 |
| `apps/api/src/modules/notifications` | 提供通知相关的 API 路由，包括获取通知列表、查询未读数量、标记单条已读和标记全部已读，作为后台消息通知模块的 HTTP 接口层。 |
| `apps/api/src/modules/notify-channels` | 通知渠道配置（#525 P2-6，决策 #516 项⑦⑧）：服务端配置存储 + 读写 API + ClawBot（iLink 协议）内嵌轻量直连。/settings「通知渠道」配置区的服务端支撑——#434 死配置的「复活成真功能」版... |
| `apps/api/src/modules/outbound-notify` | 本模块提供基于 Discord 的通知发送服务，支持多种任务与会议相关通知类型。内部封装了对 discordNotifier 的调用，并通过 eventBus 将通知事件发布到消息总线。还暴露 HTTP 路由供内部模块通过 POST... |
| `apps/api/src/modules/pmo` | 项目管理办公室（PMO）：OKR 管理 + 项目 CRUD + 交付守卫。PMO 是链条脊椎：id = 分支名、需求文档挂载点、状态 = WU 汇总 + 证据台账、交付策略挂在项目上。统一编号 PMO-<n>。 |
| `apps/api/src/modules/projects` | Project Discovery（AC-D1 + AC-D3）：发现已注册的工程（repo）信息并对外提供查询 API，供频道默认工程、WorkUnit 工程绑定等流程使用。 |
| `apps/api/src/modules/requirements` | REQ 需求编号体系（vision §5.3）：一个需求（REQ-<序号>）= 一组 WorkUnit。负责 REQ 的创建、绑定解析与状态汇总，需求文档/SDD/产物以编号关联，UI 按编号串联全链路。 |
| `apps/api/src/modules/review-proposal` | 人审提案卡生命周期唯一正本（#351，docs/adr/2026-08-25-review-proposal-lifecycle-module.md）： |
| `apps/api/src/modules/role-memory` | 角色记忆存储服务：per-role 目录落数据区（经 studioPath()），三件套--MEMORY.md 索引 + topics/*.md topic 正文 + draft.jsonl append-only 草稿区。role-... |
| `apps/api/src/modules/skills` | skills 模块负责技能（Skill）的完整生命周期管理，包括基于文件的技能元数据存储（SkillStore）、技能目录扫描与加载（manifest-loader）、基于描述的技能匹配（skill-selector）、从 WorkU... |
| `apps/api/src/modules/specs` | 提供 Specs 模块的 HTTP API 路由，包括变更分析、变更历史查询和门禁验证（待实现）。遵循 SP-002 变更分级流程，通过调用外部 SDK 中的服务处理 Spec 变更相关的业务逻辑。 |
| `apps/api/src/modules/transcripts` | transcript 归档器（#97，#88 子票）：把会话原文落盘到数据区（经 studioDir()/studioPath()），供四个消费方共用——#99 WU 收尾批量提取（要全文）、handoff 摘要（要对话）、#85 执... |
| `apps/api/src/modules/triage` | 实现错误的分类（triage）与严重度评估，提供策略路由（auto_retry / manual_fix / escalate / ignore），支持开发者错误和系统级事件的分类。 |
| `apps/api/src/modules/triggers` | Trigger 子系统（AS-026，3.28c-4）：SCHEDULE（cron）+ EVENT（EventBus）两类条件的触发器调度与持久化，动作包括 CREATE WorkUnit / UPDATE / EXECUTE。系统默... |
| `apps/api/src/modules/workspaces` | 本机 Workspace 记录的自动注册与查询（只读 list/get + 删除）、CLI 运行时清单扫描。Token 管理已随 #481 退役删除。 |
| `apps/api/src/modules/workunit` | WorkUnit 核心域: 任务单元 CRUD、认领与状态机; F5 双向沟通的 NEED_INPUT 挂起/恢复与超时提醒。 |
| `packages/studio-agent` | Sub-agent 的完整生命周期管理：创建隔离 worktree → 传播 harness 配置 → spawn provider CLI（单 session）→ stream-json 解析与事件发射。完成判定/状态机不在本包，由... |
| `packages/studio-audit` | 提供审计日志的记录、查询、统计与导出功能。通过 AuditService 进行持久化日志操作（JSONL 存储）。 |
| `packages/studio-capability` | 本目录负责能力管理（CapabilityService）。CapabilityService 提供能力的 CRUD、同步、统计，并基于 FileStore JSON 文件存储实现（替代 Prisma）。 |
| `packages/studio-notification` | 本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记，服务层基于 FileStore 实现持久化通知管理。 |
| `packages/studio-shared` | 跨 apps/packages 的共享层：provider 注册表（agent CLI 定义与 spawn 模板）、FileStore（全部运行时数据的文件存储）、eventBus、共享类型与工具、 harness 运行时。Node-... |
| `packages/studio-skill` | 本目录是 Studio Skill 的核心模块，负责 Skill 的定义类型、从磁盘加载 Skill 定义（支持 frontmatter 解析和缓存）。为 Agent prompt 注入可加载的能力单元。内置 skill 库正本随包分... |
| `packages/studio-spec` | 本目录提供 Spec 的变更分析与门禁检查能力，是 Studio 中 Spec 质量管控与变更管理的核心模块。支持变更分级（L1-L4）与自动审批推荐，并实现门禁检查以管控变更上线。 |
<!-- /AUTO-GENERATED:modules -->
<!-- /PRESERVE:modules -->

<!-- PRESERVE:agent-skills -->
## Agent skills

### Issue tracker

Issues 存放在本仓库的 GitHub Issues（dommaker/studio），通过 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准 triage 标签原名使用（needs-triage 等）。见 `docs/agents/triage-labels.md`。

### Domain docs

single-context：根 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

> 本节由 setup-matt-pocock-skills 初始化写入；2026-08-21 起唯一正本自 CLAUDE.md 归位本段（#300/#303）。
<!-- /PRESERVE:agent-skills -->
