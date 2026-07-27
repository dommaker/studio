# knowledge

> 此文件描述 apps/api/src/modules/knowledge 目录的职责和上下文
> Updated: 2026-06-11 (GAP-7 元数据驱动注入 + error logging 修复)

## 职责

知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。

- **摄入（Ingest）**: 7 类 producer 往里写（preference/rule/env/decision/pattern/external/behavior）
- **消费（Consume）**: 2 条路径 — prompt 注入（knowledgeService.injectContext）+ 按需查询（search/UnifiedQuery）
- **质量（Quality）**: 去重、衰减、成熟度、low_quality 过滤
- **演化（Evolve）**: 重复知识 → Skill 化

## 核心导出

| 模块 | 路径 | 职责 |
|------|------|------|
| `knowledgeBus` | `knowledge-bus.service.ts` | 兼容层（thin compat，R4 收敛）— 共享知识总线 write/search API |
| `knowledge-singletons` | `knowledge-singletons.ts` | 共享单例唯一所有者（sharedStore 等）+ 向量库同步 + 统一质量门（R4） |
| `UnifiedQuery` | `engine/unified-query.ts` | 双存储统一查询（Prisma + KnowledgeStore），knowledgeService 的 query 引擎（R4 修复接线） |
| `knowledgeService.injectContext` | `knowledge-service.ts` | 统一 prompt 注入入口（absorbed from prompt-builder）；E2：有注入时附「何时查知识库」指引（`KNOWLEDGE_QUERY_GUIDANCE`） |
| `knowledgeService.semanticSearch` | `knowledge-service.ts` | mcp-local-rag 语义检索；E2：可用性探测（进程内缓存 5min）+ 失败降级关键词检索，不再静默返回 [] |
| `signalAggregator` | `signal-aggregator.ts` | 原始 signal 条目 → 趋势聚合摘要（≥3次/7天） |
| `fetchExternal` | `producers/external-fetcher.ts` | 外部文档抓取 + 摄入 |
| `knowledgeRoutes` | `routes.ts` | REST API 挂载门面（挂载下方 6 个子路由，含 /unified 统一浏览） |
| `ImproverScheduler` | `improver-scheduler.service.ts` | 自文档化调度器（每小时刷新 stale CONTEXT.md + 生成架构文档） |

## 目录结构

```
knowledge/
├── engine/                    # 存储/查询层
│   └── unified-query.ts       # 双存储统一查询
├── consumers/                 # 消费层
│   └── prompt-builder.ts      # prompt 注入
├── producers/                 # 生产层
│   └── external-fetcher.ts    # 外部文档抓取
├── knowledge-bus.service.ts   # 兼容层：KnowledgeBus 类 + 单例 re-export（R4）
├── knowledge-singletons.ts    # 共享单例/向量库同步/统一质量门（R4 收敛）
├── knowledge-service.ts       # 统一知识能力层（injectContext + CRUD）
├── knowledge-service.routes.ts # KnowledgeService HTTP API + SSE
├── knowledge-query.service.ts # 5 类缺口查询（query/getStats）
├── knowledge-sync.service.ts  # 自动同步 + 新鲜度检测
├── signal-aggregator.ts       # Signal 趋势聚合（PostEval 触发）
├── resolution.service.ts      # 解法库（独立子系统）
├── evolution.service.ts       # 知识演化
├── evolution-scheduler.ts     # 演化调度
├── improver-scheduler.service.ts # 自文档化调度器（refreshStaleContext + runArchDocs）
├── preference-observer.ts     # Producer: 用户偏好
├── rule-scanner.ts            # Producer: 业务规则
├── env-snapper.ts             # Producer: 环境快照
├── pattern-miner.ts           # Producer: 交互模式
├── decision-chain-extractor.ts # Producer: 决策链
├── eval-case-generator.ts     # Producer: 评估用例
├── routes.ts                  # API 路由门面（挂载子路由，导出 knowledgeRoutes/knowledgeInternalRoutes 不变）
├── document-store.ts          # 文档 FileStore 存取助手（DocRecord + list/get/save + 项目读取）
├── documents.routes.ts        # 子路由：文档列表/详情/CRUD/归档/审批
├── files.routes.ts            # 子路由：文件浏览（/requirements /read-file /file）
├── entries.routes.ts          # 子路由：知识条目（/export /ask /gaps /unified）
├── evolution.routes.ts        # 子路由：知识进化（/evolution/*）
├── search.routes.ts           # 子路由：检索与解法指标（/resolutions /search /resolution/*）
├── internal.routes.ts         # 子路由：内部端点（/sync-status /upsert /extract-*，无 auth）
└── import.routes.ts           # 文件导入路由
```

## 依赖关系

- **上游**: `@dommaker/harness`（KnowledgeStore/KnowledgeIngest/KnowledgeLifecycle）
- **上游**: `@dommaker/studio-shared`（FileStore / logger / modelGateway）
- **下游**: `agents/*`（通过 knowledgeService.injectContext 注入 prompt）
- **下游**: `channels/*`（conversation-handler）

## 注意事项

- Producer（preference-observer 等）直写 KnowledgeStore（FileStore 存储；Prisma 已全量移除）
- Resolution 和 Incident 是独立子系统，不纳入统一查询
- `knowledgeBus` 的 `formatIndexSummary()` 已删除（零调用方，被 `buildKnowledgeContext` 替代）
- `applicableAgents` 存储在 tags 中（`agent:executor` 格式），KnowledgeEntry 无此字段
- **鉴权（2026-07-24 收紧）**：`/api/knowledge`（internal.routes，不在 /api/v1 大门内）2026-07-24 起挂载 requireLocalhost——此前全匿名：POST /upsert 可污染知识库、POST /extract-text-sync 盗用服务器 LLM key、GET /sync-status 有 heal 写副作用；本机脚本经回环调用不受影响。
- **鉴权（2026-07-24 收紧）**：/api/v1/knowledge 子路由写端点（documents 6 条、entries /ask+/unified、evolution 4 条、files /read-file、import /scan+/execute）与 /api/v1/knowledge-service 写 11 条已收 requireAuth+requireNotGuest；files/import 的 startsWith 路径前缀校验无分隔符（兄弟目录可绕，未修）；knowledge-service GET /entries/stats 被 :id 遮蔽（未修）。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07-27: P0 修复 5 — knowledge-service/knowledge-singletons/resolution/evolution 的 ~/.studio/logs 事件文件统一走 utils/studio-log-path 测试隔离（VITEST → os.tmpdir()/studio-test-logs，生产行为不变）
- ✅ 2026-07-24: /api/knowledge 挂 requireLocalhost；v1 写端点收 requireAuth+requireNotGuest
- ✅ `e5142f65`: ci): resolve logger.error type errors in knowledge/routes.ts
- ✅ `11ba99fa`: ci): resolve type errors in migrated agent/knowledge files
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
- ✅ `b85449b1`: db-removal): final sweep — 全仓库 prisma 引用清零
- ✅ `389c9e87`: add await to all sdd-utils consumers after Phase 4 async migration
- ✅ `ab28f573`: pipeline-removal): code review warnings — dead scope configs + pipeline-dashboard deletion
- ✅ `ea7b91c9`: knowledge): persist extractFromExecution to StudioEvent (B59-002)
- ✅ B56: 删 formatIndexSummary() + analyst-knowledge 死链路（loadKnowledge/saveKnowledge/selectRelevantSections）— KnowledgeStore 闭环已覆盖
- ✅ B56: refreshStaleContext — 自动刷新 stale CONTEXT.md（扫描 ⚠️ 标记 → 提取代码结构 → LLM 填充空章节 → 保留修复历史）+ startScheduler 替换 runSelfDoc
- ✅ `c386e578`: AuditorAgent logger + KnowledgeBus orphan cleanup + retry cap
- ✅ `c0beddbd`: B38 错误日志修复 + GAP-7 元数据驱动注入
- ✅ `36a91ee2`: O2-KR1 注入命中率接线 — consumption 事件 + metric query
- ✅ `556051f2`: B34 behavior distillation output path + PatternMiner startup + agent-runner --verbose
- ✅ `79f4a186`: knowledge quality gate + CPU monitoring + type fix
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ GAP-7: 元数据驱动注入 — context/signal 层传 agentType 过滤 applicableAgents
