# knowledge

> 此文件描述 apps/api/src/modules/knowledge 目录的职责和上下文

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/knowledge-bus.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/knowledge-bus.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/CONTEXT.md, apps/api/src/modules/knowledge/evolution-scheduler.ts, apps/api/src/modules/knowledge/evolution.service.ts, apps/api/src/modules/knowledge/import.routes.ts, apps/api/src/modules/knowledge/routes.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/knowledge-bus.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/routes.ts, apps/api/src/modules/knowledge/preference-observer.ts, apps/api/src/modules/knowledge/pattern-miner.ts, apps/api/src/modules/knowledge/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/evolution.service.ts, apps/api/src/modules/knowledge/routes.ts, apps/api/src/modules/knowledge/knowledge-bus.service.ts, apps/api/src/modules/knowledge/resolution.service.ts, apps/api/src/modules/knowledge/knowledge-sync.service.ts

<!-- STALE_SINCE: 2026-05-30 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/knowledge/CONTEXT.md

## 职责

<!-- 本目录的核心职责是什么 -->

## 核心导出

<!-- 本目录对外暴露的主要模块/函数 -->

## 依赖关系

<!-- 本目录依赖哪些其他模块，谁依赖本目录 -->

## 注意事项

<!-- 开发时需要注意的约束或约定 -->

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `d073972f`: preflight 磁盘检查 + 孤儿进程清理 + roadmap B14 启动流水线
- ✅ `1697c52a`: knowledge): E1 — EvolutionService 成熟度对齐 harness 4 级
- ✅ `9a1027e4`: knowledge): B13-008 — EvolutionService 飞轮接桥到 KnowledgeBus
- ✅ `79c3de0a`: knowledge): B13 飞轮闭环 — Resolution→local-rag + 行为趋势 + maturity 排序
- ✅ `4e030094`: knowledge): B13-006 — matchResolutions 匹配结果日志
- ✅ `2fa7e873`: knowledge): B13-004 — formatIndexSummary 注入知识条目 + recordReference
- ✅ `4fe7f0a1`: rewrite B9-021/022 endpoints to use KnowledgeStore instead of deleted KnowledgeService
- ✅ `ce7c3955`: knowledge extraction JSON parse failure + localeCompare crash
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `a88bccd6`: tsc-gate surgical baseline update + fix 13 pre-existing TS errors
- ✅ `d136e830`: getRecentContext crash — lastReferenced undefined on process entries
