# apps/api/src/modules/knowledge

> Updated: 2026-06-11 (GAP-7 元数据驱动注入 + error logging 修复)

### 职责

知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。

- **摄入（Ingest）**: 7 类 producer 往里写（preference/rule/env/decision/pattern/external/behavior）
- **消费（Consume）**: 2 条路径 — prompt 注入（knowledgeService.injectContext）+ 按需查询（search/UnifiedQuery）
- **质量（Quality）**: 去重、衰减、成熟度、low_quality 过滤
- **演化（Evolve）**: 重复知识 → Skill 化

### 核心导出

| 模块 | 路径 | 职责 |
|------|------|------|
| `knowledgeBus` | `knowledge-bus.service.ts` | 兼容层（thin compat，R4 收敛）— 共享知识总线 write/search API |
| `knowledge-singletons` | `knowledge-singletons.ts` | 共享单例唯一所有者（sharedStore 等）+ 向量库同步 + 统一质量门（R4） |
| `UnifiedQuery` | `engine/unified-query.ts` | 双存储统一查询（Prisma + KnowledgeStore），knowledgeService 的 query 引擎（R4 修复接线） |
| `knowledgeService.injectContext` | `knowledge-service.ts` | 统一 prompt 注入入口（absorbed from prompt-builder）；E2：有注入时附「何时查知识库」指引（`KNOWLEDGE_QUERY_GUIDANCE`）；#91：maxTokens 由 prompt-composer 按分段定额传入（knowledge 1000 + 池余量），`knowledge:inject-trimmed` 事件补 originalTokens/keptTokens 尺寸字段，返回值带 `usage` 供 `prompt:section_trimmed` 埋点 |
| `knowledgeService.semanticSearch` | `knowledge-service.ts` | mcp-local-rag 语义检索；E2：可用性探测（进程内缓存 5min）+ 失败降级关键词检索，不再静默返回 [] |
| `knowledge-types` | `knowledge-types.ts` | KnowledgeService 的 Studio 侧类型 + `KnowledgeServiceDeps` + `ENTRY_TYPE_MAP`（knowledge-service.ts 拆出，门面 re-export） |
| `knowledge-data-layer` | `knowledge-data-layer.ts` | 数据层：`writeTrendData`（data/trends 趋势写入）+ resolution 影子库 FileStore helpers + 共享 `fileStore`/`STUDIO_EVENTS_JSONL`（knowledge-service.ts 拆出） |
| `knowledge-forms` | `knowledge-forms.ts` | 知识形态门禁 `validateKnowledgeForm`（knowledge/data/skill/rule，代码层判断不调 LLM）（knowledge-service.ts 拆出，门面 re-export） |
| `inject-context` | `inject-context.ts` | injectContext 注入闸门与预算：R3 提案闸门（isInjectableMaturity）、来源凭证、2K `INJECT_TOKEN_BUDGET`、注入优先级、`KNOWLEDGE_QUERY_GUIDANCE`、stripFormat（knowledge-service.ts 拆出，门面 re-export） |
| `conversation-extraction` | `conversation-extraction.ts` | R3 会话提取：transcript 构建 + 单条入库 proposal 闸门 + 审核闭环 knowledge_proposal 提案卡（knowledge-service.ts 拆出） |
| `knowledge-metrics` | `knowledge-metrics.ts` | R1/M1 事件流度量纯函数：computeOutcomeMetrics（hitRate/improvement）+ scanKnowledgeEvents（审计计数）（knowledge-service.ts 拆出） |
| `knowledge-search-helpers` | `knowledge-search-helpers.ts` | 检索 helpers：关键词抽取（STOP_WORDS）/TYPE_WEIGHT + mcp-local-rag 探测与关键词降级映射（knowledge-service.ts 拆出） |
| `knowledgeRoutes` | `routes.ts` | REST API 挂载门面（挂载下方 6 个子路由，含 /unified 统一浏览） |
| `ImproverScheduler` | `improver-scheduler.service.ts` | 自文档化调度器（每小时刷新 stale CONTEXT.md + 生成架构文档） |

### 目录结构

```
knowledge/
├── engine/                    # 存储/查询层
│   └── unified-query.ts       # 双存储统一查询
├── knowledge-bus.service.ts   # 兼容层：KnowledgeBus 类 + 单例 re-export（R4）
├── knowledge-singletons.ts    # 共享单例/向量库同步/统一质量门（R4 收敛）
├── knowledge-service.ts       # 统一知识能力层（KnowledgeService 编排 + 单例接线；工单 29 拆分后聚焦编排）
├── knowledge-metrics.ts       # Measure 纯函数内核：飞轮度量/健康/审计 + 度量类型（工单 29 拆出）
├── trend-data.ts              # trends 数据层 writeTrendData（工单 29 拆出）
├── knowledge-form-gate.ts     # 知识形态门禁 validateKnowledgeForm（工单 29 拆出）
├── conversation-extractor.ts  # R3 会话提取管道 + knowledge_proposal 提案卡（工单 29 拆出）
├── knowledge-semantic-search.ts # mcp-local-rag 语义检索支撑：探测/CLI/降级映射（工单 29 拆出）
├── knowledge-types.ts         # KnowledgeService 类型 + ENTRY_TYPE_MAP（knowledge-service 拆出）
├── knowledge-data-layer.ts    # trends/resolutions 数据层 + 共享 fileStore（knowledge-service 拆出）
├── knowledge-forms.ts         # 知识形态门禁 validateKnowledgeForm（knowledge-service 拆出）
├── inject-context.ts          # injectContext 注入闸门/2K 预算/检索指引（knowledge-service 拆出）
├── conversation-extraction.ts # R3 会话提取 + 提案卡（knowledge-service 拆出）
├── knowledge-search-helpers.ts # 关键词/RAG 降级检索 helpers（knowledge-service 拆出）
├── knowledge-service.routes.ts # KnowledgeService HTTP API + SSE
├── knowledge-query.service.ts # 5 类缺口查询（query/getStats）
├── knowledge-sync.service.ts  # 自动同步 + 新鲜度检测
├── resolution.service.ts      # 解法库（独立子系统）
├── evolution-scheduler.ts     # 周期任务调度（G-005 模式挖掘 + eval spring cleaning）
├── improver-scheduler.service.ts # 自文档化调度器（refreshStaleContext + runArchDocs）
├── preference-observer.ts     # Producer: 用户偏好
├── rule-scanner.ts            # Producer: 业务规则
├── env-snapper.ts             # Producer: 环境快照
├── pattern-miner.ts           # Producer: 交互模式
├── decision-chain-extractor.ts # Producer: 决策链
├── eval-case-generator.ts     # Producer: 评估用例
├── routes.ts                  # API 路由门面（挂载子路由，导出 knowledgeRoutes/knowledgeInternalRoutes 不变）
├── files.routes.ts            # 子路由：文件浏览（/requirements /read-file /file）
├── entries.routes.ts          # 子路由：知识条目（/export /ask /gaps /unified）
├── search.routes.ts           # 子路由：检索与解法指标（/resolutions /search /resolution/*）
└── internal.routes.ts         # 子路由：内部端点（/sync-status /upsert，无 auth）
```

### 依赖关系

- **上游**: `@dommaker/harness`（KnowledgeStore/KnowledgeIngest/KnowledgeLifecycle）
- **上游**: `@dommaker/studio-shared`（FileStore / logger / modelGateway）
- **下游**: `agents/*`（通过 knowledgeService.injectContext 注入 prompt）
- **下游**: `channels/*`（conversation-handler）

### 注意事项

- **知识库边界（#93，2026-08-13）**：KB = 项目级共享知识（跨角色 rule/context/signal/reference）。角色记忆（#100 的 per-role `MEMORY.md` + topic 文件体系）**不进知识库、不走 injectContext**；守卫约定 = 角色记忆条目带 `role-memory` tag，注入闸门（`isRoleMemory`）一律拦截，回归测试见 `__tests__/knowledge-service-inject-wiring.test.ts`。
- **#93 注入修复（2026-08-13）**：rule/context 注入曾恒空——`unified-query.ts` 合成条目 `sourceReferences` 恒 `[]` 被 `hasSourceReferences` 闸门全拦。修复 = 合成端（preferenceToEntry/ruleToEntry/envToEntry）从 store 条目 id / snapshot 文件名派生真实出处；手动创建 API（entries.routes.ts POST /unified）stamp `manual:<user>` 出处。闸门语义不变：无凭证不注入。
- 另知：`inject-context.ts` 当前零 importer（knowledge-service.ts 底部自持同一份 R3 闸门/来源凭证/INJECT_TOKEN_BUDGET/injectPriority 拷贝），属拆分后未清理的死模块（未修，2026-08-11 发现）。
- **测试稳定性（2026-08-04 已修）**：`__tests__/knowledge-bus-sync.test.ts` 的「失败后恢复 → recovered」用例原为预存 flake，根因非定时器节奏——是该用例对 `@dommaker/studio-shared` 重复 `vi.doMock` 两次，import 偶发绑定先注册的 factory（`logger.info` 为不可见 `vi.fn()`），致 recovered/synced 断言抖动。已收敛为单一注册点（`mockDeps` 增 `loggerInfo` 参数），100 轮复跑零失败。
- **knowledge-service.ts 类体不再拆分（2026-08-04 决议，接受现状 1143 行）**：模块级代码已全部抽至上述 7 个模块；KnowledgeService 类体（约 1021 行）整体保留，因 `__tests__/knowledge-service.test.ts` 锁定 prototype 恰好 35 个方法（含 5 个 private，TS private 运行时挂 prototype），任何拆类都会打破该测试。后续若要拆类，须先获批准放宽该断言（如改为 ≥35 或只锁 public 集合）。
- Producer（preference-observer 等）直写 KnowledgeStore（FileStore 存储；Prisma 已全量移除）
- Resolution 和 Incident 是独立子系统，不纳入统一查询
- `knowledgeBus` 的 `formatIndexSummary()` 已删除（零调用方；替代者 `buildKnowledgeContext` 亦已于 2026-07-27 清理，现注入入口为 `knowledgeService.injectContext`）
- `applicableAgents` 存储在 tags 中（`agent:executor` 格式），KnowledgeEntry 无此字段
- **鉴权（2026-07-24 收紧）**：`/api/knowledge`（internal.routes，不在 /api/v1 大门内）2026-07-24 起挂载 requireLocalhost——此前全匿名：POST /upsert 可污染知识库、GET /sync-status 有 heal 写副作用；本机脚本经回环调用不受影响。（POST /extract-text-sync 已于 2026-07-28 删除：直连 DeepSeek HTTP API 时代的 debug 路由，绕过 CLI 且零调用方）
- **鉴权（2026-07-24 收紧）**：/api/v1/knowledge 子路由写端点（entries /ask+/unified、files /read-file）与 /api/v1/knowledge-service 写 11 条已收 requireAuth+requireNotGuest；knowledge-service GET /entries/stats 被 :id 遮蔽（未修）。
- **document-store 退役（#149，2026-08-15）**：`~/.studio/data/documents`（DocRecord FileStore）整体退役——角色已由业务仓 `.studio/` 与知识引擎 unified entries 接管，生产数据为零（24 个文件全是 p1/c1 测试夹具，已归档为 `~/.studio/data/documents.retired-20260815.tar.gz`）。摘除面：document-store.ts、documents.routes.ts（文档 CRUD/审核）、evolution.service.ts + evolution.routes.ts（知识进化引擎 §12.12，持久化只落在该目录；evolution-scheduler 保留模式挖掘/eval cleaning）、import.routes.ts（冷启动导入，execute 写该目录）、mcp/knowledge.tools.ts（5 个 MCP 知识工具全是该目录 CRUD）、internal /upsert 的 Document 投影、search 的 document 源；web 侧 KnowledgeDocGrid/DocReaderDrawer/KnowledgeImportPage/PMO 文档计数徽章同步摘除。
- **#90 outcome 事件 errorType（2026-08-13）**：`ExecutionOutcome` 增 `errorType?`（knowledge-service.ts 门面内联定义与 knowledge-types.ts 同构两处）；`recordOutcome` payload 携带 errorType（success 时 undefined 被 JSON.stringify 丢弃）。失败步（success=false + errorType=execution_failed）由 agent-loop `recordOutcomeEvent` 落 `knowledge:outcome:failure`，供失败分析/门禁消费。
- **#323 bench 发现（2026-08-25）**：knowledge 任何写入（recordPattern/ingest/resolution 等）都会 `scheduleVectorDbSync` → `execFile('systemd-run', …)` 起 mcp-local-rag ingest 写共享生产 lancedb（`~/.cache/mcp-local-rag/lancedb`）+ 30min 超时子进程吊住宿主进程事件 loop。模块内部直线调用（`ingestWithQualityGate` 体内），exports 桩拦不住；bench/隔离环境要阻断须在 PATH 前置假 `systemd-run`（apps/api/bench/loop-read-metrics.ts 有现成做法）。
