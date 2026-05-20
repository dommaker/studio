# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.0] - 2026-05-03

### Added

#### T-007: 4 Agent 执行体系
- **Executor Agent**: AgentExecutor (Docker/Codex spawn)，全栈执行，不按 Role 分派
- **Review Agent**: LLM 直调审查代码变更 (modelGateway.promptJson)，Executor 完成后自动触发
- **Knowledge Agent**: 异步从执行结果中提取知识，存入 harness KnowledgeStore
- **Monitor Agent**: 定时检查项目健康状态（失败趋势、卡住的 Goal）
- AgentEventListener: Redis 事件驱动，串联 Executor → Review → Knowledge 流程
- 类型定义: `apps/api/src/modules/agents/types.ts` (ReviewResult, KnowledgeExtraction, MonitorAlert)

#### T-005: Goal 驱动完全替代 Workflow
- GoalScheduler 直接调 AgentExecutor.execute()，去掉 agent-runtime 中间层
- agent.completed / agent.failed 事件通过 Redis 'events' 频道发布
- POST /api/v1/executions 手动执行返回 410 DEPRECATED

#### skills/stats 迁移
- GET /api/v1/skills/stats: DB 聚合替代 runtime proxy
- 返回 totalSkills, publishedSkills, avgSuccessRate, topSkills, byCategory

### Changed

#### T-046: applyChange 持久化
- change-approver.service.ts: 内存 Map → Prisma SpecChangeRequest 表
- get()/list() 变为 async，gate-checker 和 specs/routes 调用处同步更新

#### T-053: 时区安全修复
- review-rules-loader.ts: calculateBusinessHours() 改用 YYYY-MM-DD 字符串比较
- 修复服务端本地 Date 与 Intl.DateTimeFormat 时区不一致导致的天数边界错误

#### runtime-proxy 清理
- 移除最后的 skills/stats 代理端点
- migration-status: stillProxied 置空，所有业务端点已迁移完成
- deprecatedEndpoint() 返回标准迁移指引

#### Executor 去 Role 映射
- goal-scheduler.ts: 去掉 prisma.role.findFirst，agentType 固定 'claude'
- 通用 prompt 不再引用 role.name

#### harness 配置同步
- harness init: 移除 CAPABILITIES.md 创建（由 sync-docs 管理）
- sync-docs: 从 governance config 读取 required_dirs，支持多目录扫描
- .harness/config.yml: 启用 standard governance + harness.version: 0.11.0
- .harness/checkpoints.yml: 重新生成默认检查点
- docs/harness-integration.md: 从 3 个集成点扩展到 12 个子系统

---

## [0.2.0] - 2026-05-02

### Added

#### Agent-Native 基础设施 (O5)
- ModelGateway 多 provider 路由 + 优先级 fallback + token 用量统计
- Role.memory JSON 列 + MemoryService (CRUD/搜索/prompt 格式化/淘汰)
- Meeting actionItems/keyFindings JSON 列 + summary service 结构化提取
- SkillExtractionService: LLM 分析执行模式 → 提案生成 → 人工审批

#### Goal 驱动架构 (O6)
- Prisma 模型: Goal + GoalPlan + GoalExecution (目标→计划→步骤执行)
- GoalService: 创建目标 / LLM 生成执行计划 / 审批 / 启动执行
- GoalPlanner: 通过 modelGateway 调用 LLM 分解目标为可执行步骤
- 架构转变: 硬编码 workflow → 人定义目标+约束，LLM 规划执行路径

#### LLM 配置体系 (§12.11)
- LLMConfig Prisma 模型: scope/provider/apiKeyEnc(AES-256-GCM)/model/options
- LLMConfigService: 加密存储 + 分层配置解析 (scope→agent_default→env)
- API: /api/v1/settings/llm (CRUD + test)，GET 返回脱敏 key
- 启动时从 DB 加载加密配置注册到 gateway

#### MCP Server (§12.9)
- MCPServer 类: stdio + JSON-RPC 2.0 协议
- 35 个 MCP tools 覆盖所有模块 (PMO/角色/任务/知识库/会议/经济/规格/Agent/安全)
- HTTP 端点: POST /api/v1/mcp, GET /api/v1/mcp/tools, POST /api/v1/mcp/tools/:name

#### Agent 三层架构 (§12.10)
- Prisma 模型: Topic + ExecutionPlan + ExecutionResult + AgentSubscription
- AgentRouter: 任务类型→agent 能力匹配路由 + 自动调度器 (15s 扫描)
- 三层架构: Orchestrator → DB → AgentRouter → Sub-agent

#### 知识进化引擎 (§12.12)
- KnowledgeEvolutionService: 微观/中观/宏观三层进化闭环
- 成熟度阶梯: draft → candidate → validated → canonical → archived
- 衰减检查: 自动归档过期文档 (execution 30d, meeting 60d, other 90d)
- API: /api/v1/knowledge/evolution/{micro,meso,macro,decay,health}

#### S2: LLM 配置 + 冷启动向导 + 知识库 UI
- Settings.tsx: 替换旧 localStorage 配置为 LLMConfigSection 组件
- KnowledgeImportPage: 4 步冷启动导入向导
- KnowledgePage: 内联文档详情面板 + 冷启动导入入口

#### S3: runtime-proxy 逐步替换
- Config 端点: 代理→本地 Redis 读写
- Projects 端点: 代理→本地 PMO 数据库操作
- Files 端点: 代理→本地文件系统 (安全目录白名单)

#### S4: Dashboard + 冲突裁决
- Dashboard 新增 Harness Tab: 知识库统计/约束执行/知识流转/反馈环
- ConflictsPage: 待裁决列表 + 裁决表单 + 已裁决状态

#### S5: 代理函数下线准备
- HTTP deprecation headers (Deprecation, Sunset, Link)
- GET /runtime/migration-status 迁移追踪端点

### Changed

#### O1: 安全修复 + PrismaClient 统一
- 移除 client.ts 硬编码 Tencent API Key
- 移除 permission-check.ts source: 'api' 权限绕过
- task-worker.ts execFile 替代 execAsync 消除 shell 注入
- 14 个无 auth 路由加 requireAuth
- 25 个文件 PrismaClient 统一到 studio-prisma 单例

#### O2: meetings god file 拆分
- meetings/routes.ts 2078 行拆分为 8 个文件
- App.tsx 658 行拆分: useExecutions/useWebSocketHandlers/useGlobalModals/GlobalModals

#### O3: 模块合并 + barrel 拆分 + stores 重构
- 删除 packages/studio-review-core 死包
- modules/notify/ → modules/outbound-notify/ 重命名
- studio-shared barrel 拆分: index.ts + node.ts
- 提取共享 canvas 类型到 types/canvas.ts
- 统一 API client: 10 处 raw fetch 替换为 api 模块方法
- authStore 加 zustand persist 中间件
- 拆分 useAppStore 为 agentStore/workflowStore/runtimeStore/uiStore

#### O4: task-worker 性能优化 + 路由注册改造
- 新增 route-registry.ts 模块化路由表
- task-queue.ts 新增 waitForTask() 使用 Redis BLPOP 事件驱动
- 并发控制: concurrency 配置 + activeTasks 并发 Map

---

## [0.1.0] - 2026-04-30

### Added
- 初始版本: 会议系统 + PMO + 角色 + 任务 + SpecReview + 经济 + 审计
- 用户认证 (JWT + 角色权限)
- WebSocket 实时通信
- 工作流执行 (@dommaker/runtime)

---

> 格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
