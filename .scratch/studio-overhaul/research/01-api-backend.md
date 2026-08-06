# 01 · apps/api 后端源码调研报告

> 调研范围：`apps/api/src` 全部（modules/、core/、daemon/、middleware/、cli/、monitoring/、utils/ 等），约 247 个 .ts 源文件 / 10.3 万行（含测试）。
> 调研方式：9 个臃肿热点文件逐行全读 + 39 个模块逐目录扫描 + 全仓 grep 交叉验证。所有结论附 `文件:行号` 证据。
> 日期：2026-08-06。

---

## 0. 总体架构形态（规划者必读）

- **装配方式**：全手工。`route-registry.ts:22` 的 `buildRouteTable()` 逐个动态 import 30+ 模块，返回硬编码的 40 余条路由数组（`route-registry.ts:181-261`），`app.ts:68,110-117` 循环 `app.use` 挂载；`index.ts`（435 行）的主入口同样是约 20 处手工 `await import()` 的冷启动任务。无自动注册，注册顺序敏感（如 `route-registry.ts:205-206` skill-demotion 须先于 skills）。
- **存储**：无数据库。真正的 FileStore 在 **`packages/studio-shared/src/file-store.ts:223`**（1334 行），不在 apps/api 内（`core/` 只有内存版 EventStore，`core/event-store.ts:8`）。FileStore **全异步、零缓存、无状态**：
  - 读：`readJson`（file-store.ts:243）每次 readFile+JSON.parse；`list*` 方法（如 listProfiles:391、listChannels:537）= readdir 后**逐文件串行 await**，N 条目 = N+1 次 IO，连 Promise.all 都没有。
  - 写：`writeJson`（:262）tmp+rename 原子写，**每次写都 fsync**。
  - 消息查询：`queryMessages`（:643）每次全量读+解析整个 messages.jsonl；`queryAllMessages`（:698）**跨频道全扫描**。
  - WorkUnit：`getIndex()` 每次全读全解析 index.json；`claimWorkUnit/upsertSnapshotLocked`（:816-877）持锁 read-modify-write 整个索引文件。
  - 锁：`withLock`（:320）mkdir 模拟 flock，10ms 轮询重试。
- **结论：全项目性能问题的总根因是 FileStore 无缓存/无索引 + 调用方全量扫描习惯**，后文性能疑点 1/2/3 都是这一根因的不同表现。重构时给 FileStore 加一层带失效的内存缓存/索引，可一次消掉三大类热点。

---

## 1. 模块清单（modules/ 39 个模块）

路由挂载证据：`route-registry.ts`（简写 rr）。

| 模块 | 职责 | 主要文件 | 对外路由 |
|---|---|---|---|
| admin | CLAUDE.md/CAPABILITIES.md 文档新鲜度检查 | docs-freshness.routes.ts | `/api/v1/admin/docs-freshness`（rr:238） |
| agent-configs | Agent 配置 CRUD + 版本快照 | routes.ts | `/api/v1/agent-configs`（rr:219） |
| **agents** | **Agent 核心编排大杂烩**（40 个源文件）：legacy CRUD、Profile/Instance CRUD、决策循环 agent-loop、Auditor/Monitor/Ops/Triage 内部 Agent、token 统计、知识维护 | agent-loop.ts、routes.ts、agent-profile/*、agent-instance/*、auditor-*(4)、monitor-*(6)、ops.service.ts、triage.service.ts、review-dispatcher.ts、token-usage.* 等 | `/api/v1/agents`（rr:186）、`/api/v1/agent-profiles`（rr:196）、`/api/v1/agent-instances`（rr:197）；ops.service 被 health 路由复用（rr:136） |
| audit | EventBus `events:audit` 审计事件持久化订阅器 | audit-subscriber.ts | 无（纯事件订阅） |
| audit-logs | 审计日志查询/统计 | routes.ts | `/api/v1/audit-logs`（rr:237） |
| auth | 注册/登录/Guest Session/JWT/OAuth/邮件验证 | routes.ts、service.ts | `/api/v1/auth`（rr:183） |
| builtin-tools | 内置工具元数据静态列表 | routes.ts | `/api/v1/builtin-tools`（rr:220） |
| capabilities | 能力注册表加载与查询 | routes.ts | `/api/v1/capabilities`（rr:204） |
| channels | Channel 驱动管线：@Analyst 触发→需求文档→Goal→执行；消息路由/转任务 | channel.routes.ts、channel-message.service.ts、message-routing.ts、convert-to-task.service.ts、discovery-exposure.service.ts、requirements-doc.routes.ts | `/api/v1/channels`（rr:190）、`/api/v1/requirements-docs`（rr:191） |
| companies | 公司 CRUD，创建时生成默认 OKR（借 pmo 的 service） | routes.ts | `/api/v1/companies`（rr:193） |
| deploy | GitHub push webhook→HMAC 校验→异步部署 | webhook.routes.ts | `/api/v1/deploy`（rr:244） |
| dingtalk / lark | 钉钉/飞书机器人回调（占位）+ 健康检查 | routes.ts | `/api/v1/dingtalk`（rr:260）、`/api/v1/lark`（rr:257） |
| discord | Discord interactions 端点（Ed25519 验签）+ 命令 runner | routes.ts、command-runner.ts | `/api/v1/discord`（rr:241） |
| environments | 环境 CRUD（environments.json） | routes.ts | `/api/v1/environments`（rr:218） |
| events | 全局事件：StudioEvent CRUD、AgentEvent 批量写、SSE 实时流、Session 摘要 | event.routes.ts、sse.routes.ts、session-summary-generator.ts、workunit-events-bridge.ts | `/api/v1/events`（rr:211-212） |
| evolution | E1 约束进化：信号→提案→人审→应用 | evolution.routes.ts、evolution.service.ts、signals/generator/channel-review/applier | `/api/v1/evolution`（rr:199） |
| executions | Execution 列表查询 **legacy 接口**，计划迁移 | routes.ts | `/api/v1/executions`（rr:188） |
| harness | Harness 治理 API 门面（轨迹/约束/护栏/知识/会话/诊断/仪表盘） | routes.ts、runtime.ts + 9 个子路由 | `/api/v1/iron-laws`（rr:210）、`/api/v1/harness`（rr:216）、`/api/v1/cso`（rr:217） |
| **knowledge** | 知识引擎 Producer→Engine→Consumer 三层：摄入/查询/演化/维护（24 个源文件） | knowledge-service.ts、knowledge-bus.service.ts、resolution.service.ts、engine/unified-query.ts、evolution.service.ts、rule-scanner.ts、7 组 routes | `/api/v1/knowledge`（rr:229）、`/api/v1/knowledge-service`（rr:230）、`/api/v1/knowledge/import`（rr:231）、`/api/knowledge` 内部 API（rr:232，localhost） |
| mcp | 系统能力 MCP 化：JSON-RPC Server、工具注册/权限/限流，8 个域工具集 | routes.ts、server.ts、tool-registry.ts、tools/ 9 个域 | `/api/v1/mcp`（rr:213） |
| monitoring | Agent Network 监控聚合（agents/stats/flywheel/overhead/overview） | monitoring.routes.ts、monitoring.service.ts、metrics.service.ts | `/api/v1/monitoring`（rr:200） |
| notifications | 通知列表/未读/已读（委托 @dommaker/studio-notification 包） | routes.ts | `/api/v1/notifications`（rr:227） |
| outbound-notify | Discord 出站推送 + 用户 Webhook 配置 | routes.ts、notify.service.ts | `/api/v1/notify`（rr:228） |
| outputs | 执行产出文档存储检索（**链路已坏，疑似死模块**，见 §5） | routes.ts | `/api/v1/outputs`（rr:214） |
| pmo | 项目管理办公室：OKR + 项目 CRUD + 交付守卫 + 进度汇总 | routes.ts、okr.service.ts、project.service.ts、delivery.ts、progress-rollup.ts 等 | `/api/v1/pmo`（rr:192） |
| projects | Project Discovery：扫描已注册工程供频道/WU 绑定 | project.routes.ts、project-discovery.service.ts | `/api/v1/projects`（rr:201） |
| requirements | REQ 需求编号体系，已退化为 PMO 只读别名层 | requirement.routes.ts、requirement.service.ts、ownership-resolver.ts 等 | `/api/v1/requirements`（rr:195） |
| runtime-config | TaskWorker 运行时配置 GET/POST | routes.ts | `/api/v1/runtime-config`（rr:215） |
| shared | 跨模块共享纯函数（failure-classifier） | failure-classifier.ts | 无 |
| skills | SkillHub 技能全生命周期：存储/选择/提取/升降级/提案 | routes.ts + 11 个 service/store | `/api/v1/skills`（rr:205-207） |
| spec-reviews | Spec 审查创建/审批/绕过 | routes.ts、spec-review.service.ts | `/api/v1/spec-reviews`（rr:223） |
| specs | Specs 变更分析（委托 @dommaker/studio-spec 包） | routes.ts | `/api/v1/specs`（rr:224） |
| triage | 错误分类纯逻辑（8 类错误标签），无路由 | error-class.ts | 无 |
| triggers | SCHEDULE(cron)+EVENT 触发器调度/YAML 持久化/动作执行 | trigger-scheduler.ts、trigger-store.ts、trigger-action.ts 等 | `/api/v1/triggers`（rr:198） |
| wiki | LLM Wiki 档案馆：SDD 文件驱动文档列表/图谱/详情 | wiki.routes.ts、wiki.service.ts | `/api/v1/wiki`（rr:233） |
| workspaces | Workspace 注册/心跳/Token/WS 网关/任务 claim/GC | ws-gateway.ts、workspace.routes.ts、daemon-routes.ts、gc-service.ts 等 | `/api/v1/workspaces`（rr:247）、`/api/v1/daemon`（rr:251）、WS `/ws/daemon` |
| workunit | WorkUnit 核心域：CRUD/Claim/状态机/NEED_INPUT/超时释放 | workunit.service.ts、workunit.routes.ts、merge-on-review-pass.ts、timeout-release.ts、waiting-input.ts、wu-messenger.ts 等 | `/api/v1/workunits`（rr:194） |

**结构分类**：
- 仅路由无 service（15 个）：admin、agent-configs、audit-logs、builtin-tools、capabilities、companies、deploy、dingtalk、environments、executions、lark、notifications、outputs、runtime-config、specs。其中 notifications/specs/harness 是委托 workspace 包的薄壳。
- 仅逻辑无路由（3 个）：audit（事件订阅）、triage（纯函数）、shared（工具）。
- 最需要警惕的结构问题：**agents/ 实际是"服务大杂烩"**——40 个源文件里混着 WU 执行循环、Auditor、Monitor、Ops、Triage、知识维护、token 统计至少 6 个子域，重构时最该按子域拆目录。
- 文档漂移：`channels/CONTEXT.md` 提到的 analyst-trigger.service.ts/analyst-executor.ts 已不存在；`auth/CONTEXT.md` 提到的 oauth.routes.ts/email.service.ts 也不存在。

---

## 2. 臃肿热点剖析（9 个文件，逐行全读）

### 2.1 `modules/agents/agent-loop.ts`（2017 行）— Agent 决策循环

**对外入口**：生产代码唯一直接 import 方是 `agent-loop-registry.ts:8` 和 `completion-gates.ts:20`（类型）；其余约 15 个 import 全是测试。

**内部职责区块**：
- L1-105 常量与守卫（SESSION_TOKEN_LIMIT/STEP_LIMIT 等）、L106-150 类型定义
- L152-1582 `AgentLoop` 类（1430 行）：生命周期 start/stop（187-456）、主循环与心跳（345-435）、观察层 observe（474-530）、**巨型方法 agentStep（533-1024，约 490 行）**、prompt 注入段构建（1037-1143）、worktree 解析（1149-1205）、**recordResult 收口编排（1287-1555，约 270 行）**
- L1584-2017 尾部 430 行模块级纯函数：输出解析、prompt 模板、知识搜索分析遗留、token 记账、tool:call 落盘

**拆分缝（按边界干净度排序）**：
- **A（零风险第一步）：1584-2017 尾部纯函数整体拆出**，不触 `this`，可再分四块：输出协议解析 → `output-parsers.ts`（1649-1756+1587-1600）；token 记账 → `token-events.ts`（1856-1972）；tool:call 落盘 → `tool-trace.ts`（1974-2017）；知识搜索分析（1797-1854）无生产调用方，**优先评估删除**。
- B：prompt 组装（1026-1143 + 1762-1795）→ `prompt-composer.ts`，依赖仅 role/fileStore。
- C：工作区/worktree 解析（1145-1205 + agentStep 内 745-809）→ `execution-workspace.ts`（有 completion-gates.ts 经 deps 注入的先例）。
- D：recordResult 收口编排（1287-1555）→ 按 deps 注入模式抽出，边界中等。
- E/F：observe 观察层（462-530）→ `observe.ts`；生命周期（187-342）→ `instance-lifecycle.ts`，优先级较低。

**重复逻辑**：
- 2K 预算截断代码三段同构（1058-1064 / 1097-1100 / 1138-1141）。
- **同一份 agent transcript 每 step 被全量 JSON.parse 4-5 遍**（1264-1280 / 1908 / 1992 / 936-944 / 1588），rawOutput 可达数百 KB。
- hint「读 metadata→注入 prompt→清除」模式重复 4 次（590-607 / 679-694）。
- `resolveWorktreesDir`（1622-1624）与 `workunit/merge-on-review-pass.ts:43` 完全同实现；`isProcessAlive`（1603-1610）与 `daemon/session-manager.ts:138` 重复。
- STEP_LIMIT 判定算两次（1401 与 1495 同一表达式）。

**最该先拆**：尾部 430 行纯函数区——零 this 依赖、测试已按函数粒度覆盖、零行为风险；其次 prompt 组装。

### 2.2 `modules/knowledge/knowledge-service.ts`（1819 行）— 知识引擎主服务

**背景**：与 `knowledge-bus.service.ts`（自我声明的兼容层，文件头 TODO 要求消费者迁走后删除，但仍有 8+ 生产调用方）、`resolution.service.ts`（主存储）存在双轨。本文件 matchResolutions/verifyResolution 仍操作自认 legacy 的 `~/.studio/data/resolutions` 影子库（:374-376），与 resolution.service.ts:125/238 形成**同语义双实现**，调用方也分裂（triage.service.ts:272 走影子库版，auditor-execution.ts:161 走主存储版）。

**内部职责区块**：类型定义约 200 行（158-360，15+ interface）；`KnowledgeService` 类（398-1416）按注释分六个能力带：Produce（417-657）、Consume（659-1062）、Track（1064-1137）、Lifecycle（1139-1195）、Resolve（1197-1213）、Measure（1215-1415）；尾部是会话提取工具（1418-1590）、事件扫描（1592-1744）、杂项工具（1746-1793）、单例接线（1795-1819，**import 写在文件尾部**）。

**拆分缝**：
- **A（最干净，约 350 行）：Measure 模块** → `knowledge-metrics.ts`。computeOutcomeMetrics(:1609)/scanKnowledgeEvents(:1670) 本就是不依赖 this 的纯函数，五个 Measure 方法只是薄封装。
- B：语义检索/RAG 模块（semanticSearch:781、execMcpQuery:828、probeMcpLocalRag:1763 等），仅两个内部调用点。
- C：Resolution 影子库（:378-394 + :992-1040 + :1396-1415）——**更优解是直接删除**，统一到 resolution.service.ts。
- D：trends 数据层 + 形态门禁（:72 + :95）纯函数，已有外部 import 方（signal-aggregator.ts:15）。
- E：会话提取管道（:1463/:1485/:1558 + extractFromConversation:494）→ `conversation-extractor.ts`，deps 已参数化（:1486）。
- 不宜先动：injectContext 与 Track/Lifecycle 的 recordReference 闭环耦合深（:764、:938）。

**重复逻辑**：ENTRY_TYPE_MAP 与 knowledge-bus.service.ts:56 逐行相同；STOP_WORDS/extractKeywords 与 knowledge-bus.service.ts:312/330 重复；两个事件扫描函数各做一遍「全量读→窗口过滤→JSON.parse 容错」（:1622-1637 vs :1695-1724）；maturity 权重表三套不同口径（:917 / :1227 / :1450）；「store.list({}) 读全量再内存过滤」7 处（:439/:887/:1125/:1220/:1251/:1285/:1379）。

**废弃痕迹**：`graduateConstraint`(:1193) 是空方法；`recordAnalystAccuracy`(:634) **生产无调用方**（文件自承两次 :349-350），导致 `getAnalystAccuracy` 恒返回 `available:false`，等于一个恒返回"不可用"的 API；疑似 bug：keywordHitsToSemantic(:1776) 读单数 `sourceReference`，而生产字段是复数（:1437 注释自承是"此前误读"复现），filePath 恒为 ''。

**最该先拆**：Measure 模块（顺手合并重复扫描、给 jsonl 全量扫描加缓存）；并删除 Resolution 影子库双实现。

### 2.3 `modules/workunit/workunit.service.ts`（1179 行）— WorkUnit 核心域

**内部职责区块**：L1-194 类型契约（`WorkUnitMetadata` 是 **60+ 字段巨型 schema**，14-127）；L197-231 状态机表/超时常量；L233-309 快照↔DTO 转换层；L311-541 CRUD+事件溯源写入；L543-654 Claim 生命周期；L656-708 状态机迁移；L710-859 评审/证据台账（F6 体系）；L860-948 异常置 blocked；L997-1050 写入共用尾部；L1052-1091 频道删除兜底重挂；L1093-1175 事件发布+父状态聚合级联。

**拆分缝**：
- **类型+常量+转换层（14-309，约 300 行）→ `workunit.types.ts` / `workunit.mappers.ts`**：零运行时依赖、零循环引用风险，且能解除 agent-loop 等跨模块对 service 文件的类型级耦合（agent-loop.ts:15 在 import ANALYSIS_TASKS_MAX）。
- F6 评审/台账写入区块（720-859、955-1050）连同 markMergeConflict/blockForManualRelease（860-948）→ 独立写入模块（`persistSnapshot`+`publishStatusChanged` 一并带走）。
- 父状态聚合（1112-1175）纯函数+FileStore，边界干净，被 4 处 fire-and-forget 调用（702/759/891/943）。
- Claim 子模块（548-654）与 CRUD 有反向依赖（claim 内复用 update:616），边界次之。
- routes 侧（workunit.routes.ts 562 行）：讨论空间三路由（439-560）可独立成 `workunit-discussion.routes.ts`；verify/dispatch-review（313-407）也可独立。

**重复逻辑**：
- **「getIndex 全量读→find(id)→改快照→appendEvent+upsertSnapshot→publishStatusChanged」骨架手写重复 9 次**（326/499/525/628/661/861/907/1075/1154）；`persistSnapshot`(1027) 只收敛了 F6 评审 5 处，其余 9 处仍手写同一尾部。
- markMergeConflict(860-896) 与 blockForManualRelease(906-948) **近乎孪生**（注释自承"事件溯源形态同"，:902）。
- fire-and-forget 样板逐字重复 4 次；`getIndex()` 全量读+find 单查 11 处。
- routes 侧错误映射样板约 10 处、agent 403 检查 4 处。

**性能**：`claim` 一次操作读 4 遍全量 index（589→555/558→606）；`list` 全量加载+内存过滤+内存排序分页（469-490），过滤条件本可下推。无同步阻塞调用。

**废弃痕迹**：`@deprecated` 字段 2 处（ownershipProjectId:55、pmoProjectId:64，注释明示"生产存量为零"）；`WorkUnitFilter` re-export（:1179）疑似无消费方。

**最该先拆**：类型与纯函数层（立刻削 300 行且零风险），第二步 F6 台账写入区块。

### 2.4 `modules/pmo/okr.service.ts`（1156 行）+ `pmo/routes.ts`（684 行）

**分工**：project.service.ts（502 行）管项目 CRUD（`~/.studio/projects/{id}.json`）；okr.service.ts 管 OKR CRUD（`~/.studio/okr/{quarter}.md` frontmatter）+ 一整套 KR 指标度量引擎；routes.ts 是 HTTP 薄层。交叉重复：okr.service.ts:401-406 扫 projects 目录与 project.service.ts:144-158 的 readAllProjects 逻辑重复。

**okr.service.ts 区块**：CRUD 五件套（133-328）；公司默认 OKR + updateProgress（355-441）；**指标度量引擎占全文件一半**（443-1153）：METRIC_REGISTRY 22+ metricType（471-599）、syncKRProgress（604-667）、22 个 metric 查询实现（684-1023）、目标校验（1025-1153）。

**拆分缝**：
- **缝 A（最干净，约 550 行）：指标度量引擎 → `okr-metrics.ts`**。对核心 CRUD 零反向依赖；唯一接口调整点是 registry 回调签名（:473 接收 okr 实例）。拆出后可单独加事件缓存/并行查询。
- 缝 B：目标校验 → `okr-validation.ts`（1065-1153），只依赖缝 A。
- 缝 C：syncKRProgress 双向依赖，需权衡。
- routes.ts 按注释横幅天然分三块（27/338/558/657）：project/okr/executions+health 三个路由文件，块间无共享函数。

**重复逻辑**：「读全量 studio-events.jsonl+按 type 过滤」内联重复 6 处（735/899/935/957/967/976），尽管已有 readEvents helper；「事件 payload 成功率」模板重复 5 处（787-800 与 803-817 几乎逐行相同）；queryKnowledgeQualityScore 与 queryKnowledgeQualityTrend **函数体完全相同**却注册了两个 metricType（549/559）；路径常量解析方式分叉（okr.service.ts:12-13 手写 vs routes.ts:24-25 用 resolveStudioLogFile，**可能解析到不同文件**）。

**废弃痕迹**：`checkPermission`(347-350) 注释明言"Role 功能已废弃"恒返回 false，但 routes.ts 三处 roleId 分支仍在调它（377/507/540）——roleId 一旦传入必 403，**死代码路径**；queryBehaviorFeedbackRate(831) 恒返回 null 却仍在 registry 注册；**5 个导出方法仅测试引用、无生产调用方**：getDefaultOKR(355)、updateProgress(397)、syncKRProgress(604)、validateKRTarget(1065)、getRecalibrationSuggestions(1129)；get() 返回 `Company:null/_count.Execution`（245-247）是 Prisma ORM 结构残留。

**最该先拆**：指标度量引擎（占一半、重复模板最多、是 /okr/metrics 无缓存全量扫描性能问题的根源）；顺带删无调用方方法和死 roleId 分支。

### 2.5 `modules/monitoring/metrics.service.ts`（666 行）

**区块**：类型定义 150 行（31-180，9 个指标组接口）；**纯聚合函数 `aggregateOverview` 单函数 385 行**（212-596），内部 9 个指标组段落；Service 层仅 70 行（598-666，Promise.all 六路读取 + 60s 缓存）。

**拆分缝**（模块作者自己画好了"纯函数 vs Service"的缝，:182/:598 注释）：
- **类型区 → `metrics.types.ts` + aggregateOverview → `metrics-aggregate.ts`**：机械移动、零风险，直接砍掉 85% 体积。
- 次级：9 个指标组段落各自可抽子函数（taskFlow 223-307、roles 366-426、tokens 452-520 优先）。

**重复逻辑**：**`workunit:tokens` 事件迭代+归因逻辑三处同源实现无共享代码**——metrics.service.ts:462-520、monitoring.service.ts:397-430（aggregateOverheadEvents，手搓 JSON.parse）、token-usage.service.ts:144/168-181/292-306；窗口 `+60_000` 时钟偏移容忍两处各写一遍（metrics:216 / monitoring.service:402）；求均值模式重复 6 次。

**性能**：`MetricsService.getOverviewMetrics` 有 60s 缓存但 `queryAllMessages`(640) 扫全频道消息只为数 human 消息；monitoring.service.ts 的 `getStats`(292-327) 每次全量 getIndex+listStates **无缓存**；同目录两文件各自全量读 studio-events.jsonl（metrics:639 / monitoring.service:362）。

**最该先拆**：类型区+聚合纯函数（85% 体积、零风险）；随后收敛三处重复的 tokens 事件归因。

### 2.6 `modules/channels/channel.routes.ts`（665 行）

**区块**：**:21-212 是一个与路由完全无关的 AC Group Markdown 状态机解析器**（parseAcGroupsFromMarkdown，占全文 27%）；路由本体（214-576）；尾部 4 个 helper（578-665）。

**拆分缝**：
- **缝 A（最干净）：21-212 解析器整段删除或移出**——纯字符串处理零依赖，且**全仓库无调用方**（grep 仅命中定义处 :34 和自引用 :47），疑似旧 orchestrator 残留，删除即得。
- 缝 B：580-665 四个 helper → `channel-helpers.ts`（注意 updateChannelMembers:610 隐式捕获模块级 fileStore 单例，抽时需统一依赖注入；3 个测试文件 import 路径需同步）。
- 缝 C：convert-to-task 两端点（517-576）→ 独立路由文件（同目录有 requirements-doc.routes.ts 先例）。

**重复逻辑**：频道对象字面量构造手写 3 遍（248-260/382/channel-init.ts:19-30）；channel 不存在 404 样板 5 处；`requireAuth()+requireNotGuest()` 组合重复 9 次；listProfiles 全量扫描后内存查找 3 处（463/584/654）。

**疑似 bug（顺带）**：GET 分页消息 **limit 实际失效**——:322-323 只 `pop()` 一条，从未 `slice(0, take)`，:326 把全量消息返回。limit 白设，频道消息越多越慢。

**废弃痕迹**：createAgentWithFileStore(:595) 仍在向已 deprecated 的 `profile.channels` 字段写入（migrate-members.ts:1-6 声明该字段"只读不删"）；`discordChannelId`/`discordWebhookUrl` 恒为 null（254-255），疑似 Discord 集成废弃残留；3 个导出 helper 仅测试引用。

**最该先拆（删）**：21-212 死解析器（27% 体积、零风险）；随后抽 helper、修分页 limit bug。

### 2.7 `modules/agents/ops.service.ts`（644 行）— 进程级守护

**关系**：与 agent-loop/triage/review-dispatcher **无任何直接调用关系**。只被 index.ts:148-151（启动健康循环）、cli/server.ts:124-136、route-registry.ts:136（getStatus）引用。是独立的进程守护：启动预检+定时自检。

**区块**：preflight 启动预检（56-208）；运行时健康循环 setInterval 5min（210-333）；getStatus 状态采集（335-394）；代理健康（396-484）；进程工具（486-522）；Worktree GC（524-557）；默认数据引导（559-619）；工厂+健康路由（622-644，**import express 写在文件尾部 628**）。

**拆分缝**：代理健康块（404-484）→ `ops-proxy.ts`（依赖最少、有独立测试可随迁）；preflight → `ops-preflight.ts`；cloudflared 逻辑散落在两处（151-168、309-326）可合并；Worktree GC（524-557）→ 但应先处理双份实现问题（见下）；getStatus+createHealthRoutes → `ops-health.ts`（与 system-health.ts 职责重叠，宜归并）。

**严重问题（优先于一切结构重构）**：
- **Worktree GC 双份实现且目录口径不一致，ops 这份很可能在扫空目录（正在运行的死代码）**：ops.service.ts:528 默认 `~/.studio/worktrees`、7 天过期；monitor-system-probes.ts:24,51-73 默认 `~/worktrees`、24 小时；agent-loop.ts:1623 实际创建用的也是 `~/worktrees`。
- 系统指标采集三处（ops:340-370 / system-health.ts:51-80 / monitor-system-probes.ts:222），三套阈值各定各的。
- cloudflared 重启命令逐字重复（159 与 321）；`ps aux|grep|wc -l` 模式三处。

**废弃痕迹**："Check DB" 块（65-90）是 Prisma 残留——仍读 DATABASE_URL、报 "New DB will be created"、检查名叫 `db-schema`，实际只做 FileStore 写探测；`createHealthRoutes`(629-644) **全仓无调用方**；`(this as any)._lastGc`（311/315）绕过类型系统；局部 `const fs = new FileStore()` 遮蔽 fs 模块（468）。

### 2.8 `middleware/auth.ts`（524 行）— 认证中间件全家桶

**区块**：类型层（25-94）；findSessionWithUser（96-106，读 sessions.json 全量+users.json 全量做 join）；工具函数（108-159）；optionalAuth/requireAuth 用户会话认证（161-282，两者主体几乎平行）；requireRole 角色门禁（284-328）；checkOwnership 资源所有权（330-400，仅支持 document）；小门禁（402-439）；requireLocalhost 网络层门禁（441-464，与认证无关）；workspaceAuth Workspace Token 认证（466-524）。

**拆分缝**（块间无横向依赖，拆 4-6 个文件完全可行）：
- **类型层（25-94）→ types.ts，最先做**：它同时是两份漂移定义的源头——middleware 的 `UserData`(:27)/`SessionData`(:38) 与 modules/auth/service.ts:17-39 是**字段不一致的两份定义**（service 有 refreshToken，middleware 有 updatedAt），同一个 users.json/sessions.json 被两套类型解读，**隐藏 bug 源**。且被 8 个中间件和 30+ 路由文件依赖。
- 工具函数 → `anonymous.ts`；session 认证（96-282）→ `session-auth.ts`；门禁（284-464）→ `guards.ts`；workspaceAuth（466-524）→ `workspace-auth.ts`（独立 FileStore 路径，零共享状态）。

**重复逻辑**：none 模式本地放行块重复 4 次（172/224/296/413）；token→verify→findSession→过期检查流水线两个变体（183-199 / 235-267）可抽公共 resolveSession；getClientIP 与 audit-logger.ts:18-24 跨文件重复；findSessionWithUser 与 service.ts:103-135 的 findSessionById/findUserById 逻辑等价；401/403 JSON 错误响应结构 12+ 次。

**性能（严重）**：**`app.ts:10` 把 optionalAuth 挂在全局，意味着所有 API 请求每请求全量读 sessions.json+users.json 两个文件再线性 find，无缓存无索引**（auth.ts:98-106、195、253）。这是全 API 的固定成本。

### 2.9 热点小结（拆分优先级总表）

| 顺位 | 动作 | 依据 |
|---|---|---|
| 1 | agent-loop.ts 尾部 430 行纯函数拆出（或删知识搜索遗留块） | 零 this 依赖、测试粒度已就绪 |
| 2 | workunit.service.ts 类型+常量+mapper（约 300 行） | 零运行时依赖，解跨模块类型耦合 |
| 3 | metrics.service.ts 类型区+aggregateOverview（85% 体积） | 作者已画好的纯函数缝 |
| 4 | channel.routes.ts 删除 178 行死解析器 | 无调用方，删除即得 |
| 5 | okr.service.ts 指标度量引擎（约 550 行） | 占一半、重复最多、性能根源 |
| 6 | knowledge-service.ts Measure 模块 + 删 Resolution 影子库 | 缝干净+消双轨 |
| 7 | middleware/auth.ts 类型层统一 + session 解析管线收敛 | 消类型漂移 bug 源+全局性能 |
| 8 | ops.service.ts 修 worktree GC 目录口径（不是拆，是修） | 正在运行的死代码 |
| 9 | 各 routes 文件错误处理样板统一（workunit/pmo/channel 各 10-20 处） | 顺手收益 |

---

## 3. 其他臃肿混乱业务逻辑（超出指定列表）

1. **agents/ 目录整体（40 个源文件）是最大的结构问题**：WU 执行循环（agent-loop）、评审派发（review-dispatcher）、停滞诊断（triage.service 519 行）、进程守护（ops.service）、Auditor 四件套（auditor-rules.ts 489 行等）、Monitor 六件套（monitor-reports.ts 409 行、monitor-system-probes.ts 377 行等）、知识维护四件、token 统计——至少 6 个子域混在一个目录。建议按子域拆 `agents/{loop,review,monitor,auditor,ops,knowledge}/`。
2. **`knowledge/knowledge-bus.service.ts`（531 行）**：自我声明的 R4 兼容层，文件头 TODO 明确要求"消费者迁到 knowledgeService 后删除本类，新代码禁止使用"，但仍有 8+ 生产调用方（pattern-miner.ts:10、internal.routes.ts:15、search.routes.ts:134、evolution.service.ts:18、resolution.service.ts:11、rule-scanner.ts:8、knowledge-sync.service.ts:14、mcp/system.tools.ts:21）。**废弃只停在注释层**，且与 knowledge-service 有大段重复（ENTRY_TYPE_MAP、STOP_WORDS、extractKeywords）。
3. **`workspaces/ws-gateway.ts`（480 行）**：WebSocket 网关，auth/心跳/discover 代理/agent-task 代理四种消息协议揉在一个 handler 里；每连接一个 30s ping setInterval（:145,:266），随连接数倍增。协议处理与连接管理可分层。
4. **`agents/triage.service.ts`（519 行）**：自动修复服务，内嵌破坏性 shell 命令安全门（guarded:24-29，曾因误删 e2e 目录/误杀进程而默认 dry-run）——诊断、分类、修复执行、知识库回写四职责一体；修复命令模板硬编码在 service 里，宜抽策略层。
5. **`daemon/session-manager.ts`（421 行）**：旧 pipeline 时代的持久 session 管理器，start() 已按 B4a 决策摘除（studio-daemon.ts:4-7、index.ts:129-134），submitJob/submitAdhocJob **全库无生产调用方**（仅测试），仅靠 getStatus/isStarted 被 3 处消费而存活（daemon-routes.ts:367、ops.service.ts:257、discord/routes.ts:117）。**基本是死代码但仍在被读状态**。
6. **`daemon/claim-loop.ts`（195 行）+ `daemon/task-executor.ts`（379 行）**：AS-020 远程 daemon 的 HTTP 轮询版实现，**全仓无生产实例化**（grep `new ClaimLoop`/`new TaskExecutor` 仅命中测试）——实际远程执行已由 ws-gateway + remote-executor 接管。574 行孤儿代码。
7. **`pmo/routes.ts` GET /projects（566-621）**：每请求 fetch runtime + 全量读 executions.jsonl + 内存 find 合并，无缓存——代理层逻辑混在路由里。
8. **`types/index.ts`（193 行）**：旧 Workflow 时代类型定义，**全库零 import**，纯死文件。

---

## 4. 性能疑点（按严重度排序）

### P0 — 全 API 级固定成本

1. **全局认证中间件每请求双 JSON 全量扫描**：`middleware/auth.ts:98-106`（findSessionWithUser 全读 sessions.json+users.json 线性 find），挂在 `app.ts:10` 全局 optionalAuth 链路上（:195/:253）。**每个 API 请求 2 次文件 IO，无缓存无索引**。影响面：全部 40+ 路由。
2. **AgentLoop.observe() 全量扫描风暴**：`agent-loop.ts:474-529`——每个 agent 实例一个 while 轮询（idle 15s 一轮，:354/387），每轮：`workUnitService.list`（内部 getIndex 全读 index.json）→ 紧接着 `fileStore.getIndex()` **再读一次**（:480）→ `listChannels()` 全目录扫（:465/483）→ `queryAllMessages()` 扫全部频道消息（:520）。**成本随 agent 实例数线性倍增**，index.json 同一轮重复读两遍。
3. **FileStore 无缓存层（总根因）**：`packages/studio-shared/src/file-store.ts`——list* 方法逐文件串行 await（:391/:537/:476）；queryMessages/queryAllMessages 每次全量读+解析 jsonl（:643/:698）；getIndex 每次全读全解析；写每次 fsync。**加一层带失效的内存缓存可一次消掉 P0/P1 大半**。

### P1 — 高频路径 N+1 / 全量扫描

4. **wu-messenger 每条系统消息扫全部频道消息**：`workunit/wu-messenger.ts:40` 调 queryAllMessages 扫所有频道 jsonl 只为找一条 anchor；在 agent 每步回帖、四类里程碑、评审转人工、超时提醒的**每条消息发送前都执行**（5 个调用方）。
5. **workunit.service.ts `getIndex()` 17 处无缓存全读**（:448/469/499/525/555/558/589/606/628/661/721/832/861/907/956/1061/1136）；单次 claim 读 4 遍全量 index（:589→:555/:558→:606）；aggregateParentStatus fire-and-forget 每次状态迁移都全量读（:1136）。
6. **跨频道消息 N+1**：`channels/channel-message.service.ts:231-234` listChannels 后 for 循环逐频道全量 queryMessages；`FileStore.getMessageById`（file-store.ts:722）跨频道全扫描，请求路径调用方 4 处（channel.routes.ts:550、message-routing.ts:70、workunit.service.ts:417、workunit.routes.ts:531）。
7. **pmo /okr/metrics 与 /okr/data-health 端点**：`pmo/routes.ts:411-428/451-459` 串行跑 22+ 个 metric，每个触发一次全量 readJsonl 或 getIndex，**单请求 20+ 次全量文件扫描**，且两个端点均无 apiCache（对比 /okr 列表有缓存，:346）；findOKRKey 是 N+1 扫描（okr.service.ts:106-113），被 5 个方法共用。
8. **knowledge-service 全量扫描群**：searchKeyword 每次全量 list 再逐条打分（:887）；extractFromExecution 去重检查每次全表（:439）；getFlywheelMetrics/getAuditReport 每次全量读只增不删的 studio-events.jsonl（:1617/:1682）；injectContext 循环逐条写盘（:763-765，N 条注入=N 次写）。
9. **list 接口 for 循环串行 await readJson（面广）**：pmo/project.service.ts:149-153、companies/routes.ts:40-44、workspaces/workspace.routes.ts:52-56、workspaces/token.routes.ts:32-49（含按 token 反扫全部 workspace）、agent-configs/routes.ts:75-82、knowledge/document-store.ts:29-33、executions/routes.ts:21-26 等。
10. **监控/报表路径全量读事件文件**：monitoring/metrics.service.ts:639-640、agents/monitor-reports.ts:141/173/252/344、agents/auditor-reports.ts:32——每次请求全读 append-only 的 studio-events.jsonl，**成本随时间线性劣化**。

### P2 — 请求/服务路径上的同步阻塞

11. `discord/routes.ts:136-154`：interaction handler 内 `execSync('tail -20 …')`；:197-208 for 循环内逐 running exec 同步 readFileSync。
12. `agents/completion-gates.ts:26,36`：每个 WU COMPLETE 收口路径 `execSync('git status …')`（timeout 5s，阻塞事件循环）。
13. `agents/ops.service.ts`：healthCheck 每 5min 串行多个 execSync（:418 ss、:454 systemctl、:492 ps aux）；preflight `npx vite build` 阻塞可达 120s（:102）。
14. 请求路径 readFileSync：capabilities/routes.ts:81（逐 tool 同步读 YAML）、pmo/project.service.ts:485、knowledge/files.routes.ts:163/204、knowledge/import.routes.ts:272、outputs/routes.ts:37/105、triggers/trigger.routes.ts:68。
15. `daemon/session-manager.ts:244/289/315`：服务器进程内同步读可能 MB 级的 .agent.log。
16. `agent-loop.ts:2013`：writeToolCallEvents 循环内逐条 **appendFileSync**，一个 step 几十次工具调用就几十次同步 IO。
17. `okr.service.ts:947-949`：async 函数里 readdirSync/existsSync。

### P3 — 广播/定时器密度

18. **SSE 全员广播**：`events/sse.routes.ts:48-61` 每条事件 fan-out 到所有 SSE 客户端；发布侧 `agents/execution-step-events.ts:32-34` 每个 agent step 发事件，且 CLI stdout **每行**提炼后直发 SSE——每个 step/每行 stdout 都是一次全员广播。
19. **随实例/连接数倍增的定时器**：ws-gateway.ts:145 ping 30s/WS 连接；sse.routes.ts:106 心跳 30s/SSE 客户端；agent-loop 15s 轮询/agent 实例；daemon/task-executor.ts:127 cancel 轮询 5s/任务（但该文件无生产实例化，见 §3-6）。
20. 单例定时器间隔合理，无需动：trigger-scheduler 60s（trigger-scheduler.ts:122）、monitor 5min+1h（monitor.service.ts:45/53）、gc-service 1h、auditor 24h、evolution-scheduler 24h/7d、ops 5min。
21. `middleware/api-cache.ts:24-29`：内存 Map 缓存**无容量上限、无过期清扫**，长期运行内存只增不减。
22. `monitoring/index.ts:25`（顶层，prom-client）：apiRequests Counter 带 path 标签，若启用会 cardinality 爆炸——好在 recordApiRequest 等 4 个函数**全库零调用方**，实际未启用。

---

## 5. 废弃痕迹

### 5.1 整模块/整文件级

| 对象 | 证据 | 判定 |
|---|---|---|
| `modules/executions/` 整模块 | routes.ts:2-3 标 `⚠️ LEGACY surface`，CONTEXT.md:28,32 明言"迁移前勿扩展"；仍注册 rr:188，web 端仍调用 | 待迁移的 legacy surface |
| `modules/outputs/` 整模块 | `saveOutput`（routes.ts:27）导出零调用方；web 端无 /outputs 引用；索引写在**内存** EventStore（:41）重启即丢、文件却在磁盘——链路已坏 | 疑似死模块 |
| `daemon/claim-loop.ts` + `daemon/task-executor.ts` | grep `new ClaimLoop`/`new TaskExecutor` 仅命中测试 | 574 行孤儿代码（WS gateway 取代 HTTP 轮询后的遗留） |
| `daemon/studio-daemon.ts` + session-manager 提交入口 | studio-daemon.ts:4-7 + index.ts:129-134 明言 start() 已摘除；submitJob/submitAdhocJob 无生产调用方 | 死代码（仅状态查询存活） |
| `types/index.ts`（193 行） | grep `from '../types'` 零命中 | 纯死文件 |
| `utils/git.ts` | 全仓零 import（agent-loop 用的是 @dommaker/studio-agent 的同名函数，agent-loop.ts:12） | 死文件 |
| `middleware/error-handler.ts:20-36` | 仍处理 Prisma 错误码 P2002/P2025——Prisma 已删除（index.ts:11 注释） | 死分支 |
| `app.ts:44-47` `/metrics/routing` | 注释自承 Pipeline 已废弃，返回恒空；cli/server.ts:203-213 还在读它 | 死端点+死消费 |

### 5.2 文件内级

- **无大段注释掉的代码块**：全仓扫描"连续 ≥10 行注释且形似代码"仅两段命中（channel.routes.ts:21、agent-loop.ts:733），均为解释性注释。这一项意外地干净。
- `knowledge/knowledge-bus.service.ts:87` @deprecated 兼容层但 8+ 生产调用方——废弃停在注释层（见 §3-2）。
- `knowledge/knowledge-service.ts:374` resolutions 影子库自认 legacy，仍双轨维护。
- `pmo/okr.service.ts`：checkPermission(347) 恒 false 的死权限分支（routes.ts 三处仍在调）；queryBehaviorFeedbackRate(831) 恒 null 仍在 registry；5 个方法仅测试引用；Prisma 结构残留（:245-247）。
- `pmo/evidence-summary.ts:21-26` parseWuMetaPmoId @deprecated 别名，且 progress-rollup.ts:25 又 re-export 扩散。
- `workunit.service.ts:55,64` 两个 @deprecated metadata 字段（注释明示"生产存量为零"）。
- `agent-loop.ts:1797-1854` 知识搜索分析块（文件头自承"preserved from original"）无生产调用方；L50、1207-1213 两处"已抽到 xxx.js"迁移指路碑注释可清。
- `channel.routes.ts:21-212` 178 行死解析器；:595 向 deprecated 字段写入；discordChannelId/discordWebhookUrl 恒 null 残留字段。
- `ops.service.ts:65-90` "Check DB" Prisma 残留；:629-644 createHealthRoutes 无调用方。
- `route-registry.ts:186-187` legacy agentRoutes 与 tokenUsageRoutes 同挂 `/api/v1/agents`。
- `middleware/auth.ts` 与 `modules/auth/service.ts` 的 UserData/SessionData **类型漂移**（auth.ts:27/38 vs service.ts:17/39）——Prisma 迁移残留，隐藏 bug 源。
- `monitoring/index.ts`（顶层）4 个自定义指标函数全库零调用方。
- `index.ts:12-14`：@dommaker/studio-task 队列默认关闭，注释明言"全库无存活生产者"，包不删只因 12 个预存失败测试。
- `FileStore.migrateChannelsEncoding`（file-store.ts:440，一次性迁移已完成）和 `FileStore.rebuildIndex`（:785）均无生产调用方。
- `modules/environments/routes.ts`：仅注册无前端/仓内消费方，疑似无实际调用（外部脚本可能性无法排除）。
- `index.ts:5,331,335` 混用 CJS `require` 于 ESM 模块（tsx 下能跑，构建后有隐患）。

### 5.3 文档漂移

- `channels/CONTEXT.md` 提及的 analyst-trigger.service.ts/analyst-executor.ts 不存在；`auth/CONTEXT.md` 提及的 oauth.routes.ts/email.service.ts 不存在。
- `knowledge-service.test.ts:8` 注释还写"Prisma delegation"；`pmo/routes.ts:590/593` 注释还说"数据库查询"——Prisma 已删除。

---

## 6. 给架构规划者的决策要点

1. **性能重构的杠杆点在 FileStore，不在业务层**：P0-1/2/3、P1-4/5/6/10 全是"无缓存全量扫描"的变体。在 `packages/studio-shared/file-store.ts` 加带失效的内存索引（或至少给 getIndex/queryMessages/sessions+users 加缓存），一次消掉大半热点，比逐模块打补丁有效。
2. **拆分顺序按"零依赖纯函数先行"**：9 个热点文件几乎都有一个"类型区+纯函数区"可以零风险先拆（agent-loop 尾部 430 行、workunit 头部 300 行、metrics 85% 体积、okr 指标引擎 550 行、knowledge Measure 350 行）。这些先动，大文件的类本体复杂度才会裸露，再动 class 内部才安全。
3. **删除优先于搬迁的清单**：channel.routes.ts:21-212 死解析器、agent-loop.ts:1797-1854 知识搜索遗留、knowledge Resolution 影子库、okr 5 个无调用方方法+死 roleId 分支、daemon/claim-loop+task-executor 574 行孤儿、types/index.ts、utils/git.ts、outputs 模块、executions legacy 模块（需先迁 web 端）。
4. **正在运行的错误（优先于结构重构）**：ops.service.ts 的 worktree GC 目录口径与 agent-loop 实际创建目录不一致（:528 vs monitor-system-probes.ts:24 / agent-loop.ts:1623）；channel.routes.ts:322 分页 limit 失效；knowledge-service.ts:1776 单复数字段错误；middleware 与 service 的 SessionData/UserData 类型漂移。
5. **agents/ 目录需要按子域重组**（40 文件、6 子域混杂），这是模块边界重构的最大单项。
6. **route-registry.ts / index.ts 的手工装配**在模块数量继续增长时应改为按目录约定自动注册（注意现有两处顺序敏感依赖：rr:186-187、rr:205-206）。
