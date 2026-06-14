# agents

> 此文件描述 apps/api/src/modules/agents 目录的职责和上下文

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/types.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/session-summary-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/types.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/session-summary-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/post-eval-agent.service.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/monitor-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/agent-context.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/ops-agent.service.ts, apps/api/src/modules/agents/triage-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/monitor-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/CONTEXT.md

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/auditor-agent.service.ts, apps/api/src/modules/agents/monitor-agent.service.ts, apps/api/src/modules/agents/post-eval-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/requirement-gate.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/ops-agent.service.ts, apps/api/src/modules/agents/monitor-agent.service.ts, apps/api/src/modules/agents/deploy-agent.service.ts, apps/api/src/modules/agents/knowledge-agent.service.ts, apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/knowledge-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/review-agent.service.ts

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/monitor-agent.service.ts

<!-- STALE_SINCE: 2026-06-14 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/agents/post-eval-agent.service.ts

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
- ✅ `1c4ac168`: SP-004): 补齐 SDD 三个缺口 — Files section + Analyst 输出 + 去 DB 读
- ✅ `c0beddbd`: B38 错误日志修复 + GAP-7 元数据驱动注入
- ✅ `309f6061`: review pipeline — diff scope + discoveredIssues exposure
- ✅ `556051f2`: B34 behavior distillation output path + PatternMiner startup + agent-runner --verbose
- ✅ `1c4bb9ae`: remove all hardcoded credentials — require env vars
- ✅ `79f4a186`: knowledge quality gate + CPU monitoring + type fix
- ✅ `bf4ad33d`: LLM architecture debt — 3-key routing + P0-P2 fixes
- ✅ `9dec006c`: 管线自举根因修复 — AC 质量 + Gate 加固 + OKR v3
- ✅ `8d4bb203`: auditor): 知识库路径统一到 ~/.studio/knowledge/
- ✅ `7ab11eb8`: knowledge sync pipeline — auto-sync to vector DB after ingest
- ✅ `d073972f`: preflight 磁盘检查 + 孤儿进程清理 + roadmap B14 启动流水线
- ✅ `79c3de0a`: knowledge): B13 飞轮闭环 — Resolution→local-rag + 行为趋势 + maturity 排序
- ✅ `62cf3d37`: knowledge): B13-009 — OpsAgent 关键失败写入 KnowledgeBus
- ✅ `958e433f`: knowledge): B13-002 — Triage resolve 时回写 Resolution
- ✅ `456cf62f`: knowledge): B13-001 — verifyResolution 接线到 Triage/Deploy
- ✅ `b2bf3f63`: branch cleanup gap — delete source after merge + clean daemon/worktree branches
- ✅ `7ab15321`: use ANTHROPIC_AUTH_TOKEN as fallback for knowledge extraction
- ✅ `ce7c3955`: knowledge extraction JSON parse failure + localeCompare crash
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `e82b47e6`: 知识飞轮自动闭环 — 消除 ingest 手动标记 + Auditor Circuit #8
- ✅ `78c6856d`: Prisma SQLite auto-parses JSON String fields — handle both string and object
- ✅ `7d5b0fda`: Phase 0 — 7 Critical bugs in pipeline quality gates and concurrency
