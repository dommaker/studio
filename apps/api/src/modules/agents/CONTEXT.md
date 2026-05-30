# agents

> 此文件描述 apps/api/src/modules/agents 目录的职责和上下文

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/types.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/session-summary-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/types.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/session-summary-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/post-eval-agent.service.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/monitor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

<!-- STALE_SINCE: 2026-05-29 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/agent-context.ts

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
- ✅ `b2bf3f63`: branch cleanup gap — delete source after merge + clean daemon/worktree branches
- ✅ `7ab15321`: use ANTHROPIC_AUTH_TOKEN as fallback for knowledge extraction
- ✅ `ce7c3955`: knowledge extraction JSON parse failure + localeCompare crash
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `e82b47e6`: 知识飞轮自动闭环 — 消除 ingest 手动标记 + Auditor Circuit #8
- ✅ `78c6856d`: Prisma SQLite auto-parses JSON String fields — handle both string and object
- ✅ `7d5b0fda`: Phase 0 — 7 Critical bugs in pipeline quality gates and concurrency
