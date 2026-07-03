---
id: "hmqdkg08yd79rou"
slug: "historical-guideline"
title: "Historical Knowledge: guideline"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 0
taskVersion: 0
tags: ["guideline", "historical", "entries:58"]
createdAt: "2026-06-14T09:12:30.274Z"
updatedAt: "2026-06-14T09:12:30.274Z"
---

# Historical Knowledge: guideline

Auto-generated from 58 knowledge entries.
Source: `~/.studio/knowledge/`

## Summary

This document aggregates historical guideline knowledge entries
extracted from the knowledge store. Each entry is preserved as a subsection
for reference and future SDD evolution.

## Entries

- [[Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: RefreshToken.family 用于 rotation 重放检测 (OWASP recommended)](#analyst-jwt-auth-system-token-refresh-oauth2-0-ref) (GUI-376)
- [[Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: User.email 仍为 @unique — OAuth 首次登录时如 email 已存在则自动 link 而非创建新用户](#analyst-jwt-auth-system-token-refresh-oauth2-0-use) (GUI-343)
- [[Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: verifyToken 是对外导出接口 — 不要改名，只改内部实现](#analyst-jwt-auth-system-token-refresh-oauth2-0-ver) (GUI-344)
- [[Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: 旧 token 切换 JWT 后全部失效 — 所有现有 session 需要重新登录（属一次性迁移成本，可接受）](#analyst-jwt-auth-system-token-refresh-oauth2-0-tok) (GUI-356)
- [[Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: 现有 token 格式: base64url(JSON).HMAC-SHA256-Hex — auth/service.ts:75-83](#analyst-jwt-auth-system-token-refresh-oauth2-0-tok) (GUI-348)
- [[Analyst] P6.5 Skill 统一：intent-router.ts 意图路由模块: 参考 parseFrontmatter 数组解析 @ loader.ts:L48-L49 — [a, b] 格式已支持](#analyst-p6-5-skill-unified-intent-router-ts-module) (GUI-018)
- [[Analyst] 创建 knowledge 冒烟测试 v2: 参考: apps/api/src/modules/knowledge/__tests__/knowledge-sync-detect.test.ts L8 导入](#analyst-create-knowledge-test-v2-apps-api-src-modu) (GUI-029)
- [[Analyst] 创建 knowledge 冒烟测试 v3 文件: 参考 smoke-test-v2.test.ts 同目录](#analyst-create-knowledge-test-v3-smoke-test-v2-tes) (GUI-024)
- [[Exec] executor: P4.5 verification: create test file](#exec-executor-p4-5-verification-create-test-file) (GUI-030)
- [[Exec] executor: Test Goal](#exec-executor-test-goal) (GUI-023)
- [[Monitor RCA] 5 alerts correlated](#monitor-rca-5-alerts-correlated) (GUI-065)
- [[Monitor] heartbeat_loss: Execution cmq8bkf4w0066ox1v2aj8mxdx 心跳丢失超过 15 分钟（Level 2）](#monitor-heartbeat-loss-execution-cmq8bkf4w0066ox1v) (GUI-025)
- [[Monitor] progress_stagnation: Execution cmqa9drue006yez3dgm6ig77f 进度停滞 30 分钟（Level 2）](#monitor-progress-stagnation-execution-cmqa9drue006) (GUI-019)
- [[Monitor] review_quality: Goal cmq2l066 review score 0 < 75 but approved. (first cycle). Review may be let](#monitor-review-quality-goal-cmq2l066-review-score-) (GUI-075)
- [[Monitor] total_time: Execution cmq64mi180034qnnh4rjoiuof 执行超过 2h（Level 2）](#monitor-total-time-execution-cmq64mi180034qnnh4rjo) (GUI-040)
- [[Monitor] total_time: Execution cmq7vt6t5009tdj0xscln1bzk 执行超过 2.5h — 需要人工介入（Level 3）](#monitor-total-time-execution-cmq7vt6t5009tdj0xscln) (GUI-022)
- [[Monitor] total_time: Goal cmq2j6a8 exceeded critical token budget: 5101K tokens](#monitor-total-time-goal-cmq2j6a8-exceeded-critical) (GUI-056)
- [[Session Feature] feat: OAuth auth system + frontend auth UI + CONTEXT sync + specs](#session-feature-feat-oauth-auth-system-frontend-au) (GUI-037)
- [[Session Feature] feat(goals): add execution retry mechanism with retryCount](#session-feature-feat-goals-add-execution-retry-mec) (GUI-036)
- [[Session Feature] feat(goals): add failure classifier + integrate with retry logic](#session-feature-feat-goals-add-failure-classifier-) (GUI-035)
- [[Session Feature] feat(skill): intent-router 意图路由 + intentKeywords 字段](#session-feature-feat-skill-intent-router-intentkey) (GUI-020)
- [[Session Feature] feat(SP-004): SDD 文件读取替代 DB — 管线消费者迁移 Step 3](#session-feature-feat-sp-004-sdd-db-pipeline-consum) (GUI-017)
- [[Session Feature] feat(SP-004): Step 5 Executor TDD + Step 6 CHANGELOG auto-gen](#session-feature-feat-sp-004-step-5-executor-tdd-st) (GUI-016)
- [[Session Fix] fix: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input](#session-fix-fix-b8-cachehitrate-cachehit-cachehit-) (GUI-010)
- [[Session Fix] fix: O2-KR1 注入命中率接线 — consumption 事件 + metric query](#session-fix-fix-o2-kr1-consumption-metric-query) (GUI-028)
- [[Session Fix] fix: replace uuid with crypto.randomUUID — no external dep](#session-fix-fix-replace-uuid-with-crypto-randomuui) (GUI-012)
- [[Session Fix] fix: review pipeline — diff scope + discoveredIssues exposure](#session-fix-fix-review-pipeline-diff-scope-discove) (GUI-027)
- [[Session Fix] fix: skill-loader trigger normalization + SKILL.md generation](#session-fix-fix-skill-loader-trigger-normalization) (GUI-026)
- [[Triage Fix] env_error (critical)](#triage-fix-env-error-critical) (GUI-033)
- [[Triage Fix] Minor issue, auto-resolved without action](#triage-fix-minor-issue-auto-resolved-without-actio) (GUI-039)
- [[Triage Fix] timeout (critical)](#triage-fix-timeout-critical) (GUI-003)
- [[Triage Fix] timeout (degraded)](#triage-fix-timeout-degraded) (GUI-032)
- [[Triage Fix] vendor_error (degraded)](#triage-fix-vendor-error-degraded) (GUI-034)
- [[行为蒸馏] test-fix skill固化](#behavior-distill-test-fix-skill) (GUI-031)
- [>-](#doc-1781428350277) (GUI-013)
- [>-](#doc-1781428350277) (GUI-014)
- [>-](#doc-1781428350277) (GUI-038)
- [>-](#doc-1781428350277) (GUI-041)
- [>-](#doc-1781428350277) (GUI-340)
- [>-](#doc-1781428350277) (GUI-341)
- [>-](#doc-1781428350277) (GUI-345)
- [>-](#doc-1781428350277) (GUI-355)
- [>-](#doc-1781428350277) (GUI-357)
- [>-](#doc-1781428350277) (GUI-365)
- [>-](#doc-1781428350277) (GUI-366)
- [>-](#doc-1781428350277) (GUI-367)
- [>-](#doc-1781428350277) (GUI-368)
- [>-](#doc-1781428350277) (GUI-377)
- [>-](#doc-1781428350278) (GUI-386)
- [>-](#doc-1781428350278) (GUI-390)
- [|-](#doc-1781428350278) (GUI-021)
- [Anthropic API Key 隔离缓存池的最佳实践](#anthropic-api-key-cache) (GUI-136)
- [Integration影响范围测试替代全量测试](#integration-test-test) (GUI-015)
- [safeIngest 成功时需输出 maturity 和 sourceRefs 日志](#safeingest-maturity-sourcerefs) (GUI-132)
- [废弃 API 端点应返回 410 Gone 而非静默保留](#api-410-gone) (GUI-096)
- [测试中模块级 `require()` 应懒加载以避免 ESM 解析失败](#test-module-require-load-esm) (GUI-101)
- [知识沉淀质量审核需关注类型分布和内容完整性](#knowledge-quality) (GUI-131)
- [验证环境应使用独立测试数据避免污染](#auth-test-data) (GUI-139)

## [Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: RefreshToken.family 用于 rotation 重放检测 (OWASP recommended)

- **ID**: `GUI-376`
- **Source**: `guideline-GUI-376.md`
- **Created**: 2026-05-24T11:22:16.108Z

RefreshToken.family 用于 rotation 重放检测 (OWASP recommended)

## [Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: User.email 仍为 @unique — OAuth 首次登录时如 email 已存在则自动 link 而非创建新用户

- **ID**: `GUI-343`
- **Source**: `guideline-GUI-343.md`
- **Created**: 2026-05-24T06:18:10.198Z

User.email 仍为 @unique — OAuth 首次登录时如 email 已存在则自动 link 而非创建新用户

## [Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: verifyToken 是对外导出接口 — 不要改名，只改内部实现

- **ID**: `GUI-344`
- **Source**: `guideline-GUI-344.md`
- **Created**: 2026-05-24T06:18:10.932Z

verifyToken 是对外导出接口 — 不要改名，只改内部实现

## [Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: 旧 token 切换 JWT 后全部失效 — 所有现有 session 需要重新登录（属一次性迁移成本，可接受）

- **ID**: `GUI-356`
- **Source**: `guideline-GUI-356.md`
- **Created**: 2026-05-24T07:28:04.742Z

旧 token 切换 JWT 后全部失效 — 所有现有 session 需要重新登录（属一次性迁移成本，可接受）

## [Analyst] JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录: 现有 token 格式: base64url(JSON).HMAC-SHA256-Hex — auth/service.ts:75-83

- **ID**: `GUI-348`
- **Source**: `guideline-GUI-348.md`
- **Created**: 2026-05-24T06:18:13.902Z

参考 service.ts:L341-L375 revoke-then-create 模式

## [Analyst] P6.5 Skill 统一：intent-router.ts 意图路由模块: 参考 parseFrontmatter 数组解析 @ loader.ts:L48-L49 — [a, b] 格式已支持

- **ID**: `GUI-018`
- **Source**: `guideline-GUI-018.md`
- **Created**: 2026-06-12T01:39:31.036Z

参考 parseFrontmatter 数组解析 @ loader.ts:L48-L49 — [a, b] 格式已支持

## [Analyst] 创建 knowledge 冒烟测试 v2: 参考: apps/api/src/modules/knowledge/__tests__/knowledge-sync-detect.test.ts L8 导入

- **ID**: `GUI-029`
- **Source**: `guideline-GUI-029.md`
- **Created**: 2026-06-11T13:56:29.347Z

Agent: executor
Success: true
Duration: 262116ms

## [Analyst] 创建 knowledge 冒烟测试 v3 文件: 参考 smoke-test-v2.test.ts 同目录

- **ID**: `GUI-024`
- **Source**: `guideline-GUI-024.md`
- **Created**: 2026-06-11T14:09:01.036Z

Agent: executor
Success: true
Duration: 90426ms

## [Exec] executor: P4.5 verification: create test file

- **ID**: `GUI-030`
- **Source**: `guideline-GUI-030.md`
- **Created**: 2026-06-10T00:39:03.192Z

Agent: executor
Success: true
Duration: 25556ms

## [Exec] executor: Test Goal

- **ID**: `GUI-023`
- **Source**: `guideline-GUI-023.md`
- **Created**: 2026-06-11T14:08:30.585Z

Agent: executor
Success: true
Duration: 86ms
Diff (2 chars): {}

## [Monitor RCA] 5 alerts correlated

- **ID**: `GUI-065`
- **Source**: `guideline-GUI-065.md`
- **Created**: 2026-06-07T03:19:59.955Z

告警: [critical] total_time: Execution cmq7vt6t5009tdj0xscln1bzk 执行超过 2.5h — 需要人工介入（Level 3）
[critical] review_quality: Goal cmq9kps0 review score 0 < 75 but approved. (first cycle). Review may be letting sub-par code through.
[critical] review_quality: Goal cmq9k9og review score 0 < 75 but approved. (after 2 cycles). Review may be letting sub-par code through.
[critical] review_quality: Goal cmq9h1j1 review score 0 < 75 but approved. (first cycle). Review may be letting sub-par code through.
[cri

> ... (truncated)

## [Monitor] heartbeat_loss: Execution cmq8bkf4w0066ox1v2aj8mxdx 心跳丢失超过 15 分钟（Level 2）

- **ID**: `GUI-025`
- **Source**: `guideline-GUI-025.md`
- **Created**: 2026-06-10T17:21:04.257Z

Execution cmqa9drue006yez3dgm6ig77f 心跳丢失超过 30 分钟 — 强制重开

## [Monitor] progress_stagnation: Execution cmqa9drue006yez3dgm6ig77f 进度停滞 30 分钟（Level 2）

- **ID**: `GUI-019`
- **Source**: `guideline-GUI-019.md`
- **Created**: 2026-06-12T02:58:37.734Z

Execution cmqa9drue006yez3dgm6ig77f 进度停滞 30 分钟（Level 2）

## [Monitor] review_quality: Goal cmq2l066 review score 0 < 75 but approved. (first cycle). Review may be let

- **ID**: `GUI-075`
- **Source**: `guideline-GUI-075.md`
- **Created**: 2026-06-06T17:30:31.718Z

Goal cmq88219 review score 0 < 75 but approved. (first cycle). Review may be letting sub-par code through.

## [Monitor] total_time: Execution cmq64mi180034qnnh4rjoiuof 执行超过 2h（Level 2）

- **ID**: `GUI-040`
- **Source**: `guideline-GUI-040.md`
- **Created**: 2026-06-09T06:44:34.547Z

Execution cmq7vt6t5009tdj0xscln1bzk 执行超过 2h（Level 2）

## [Monitor] total_time: Execution cmq7vt6t5009tdj0xscln1bzk 执行超过 2.5h — 需要人工介入（Level 3）

- **ID**: `GUI-022`
- **Source**: `guideline-GUI-022.md`
- **Created**: 2026-06-10T17:06:06.257Z

Execution cmq7vt6t5009tdj0xscln1bzk 执行超过 2.5h — 需要人工介入（Level 3）

## [Monitor] total_time: Goal cmq2j6a8 exceeded critical token budget: 5101K tokens

- **ID**: `GUI-056`
- **Source**: `guideline-GUI-056.md`
- **Created**: 2026-06-08T23:35:08.943Z

Goal cmq8auc7 exceeded critical token budget: 29877K tokens

## [Session Feature] feat: OAuth auth system + frontend auth UI + CONTEXT sync + specs

- **ID**: `GUI-037`
- **Source**: `guideline-GUI-037.md`
- **Created**: 2026-06-09T12:41:29.757Z

Commit: 885f6064
Message: feat: OAuth auth system + frontend auth UI + CONTEXT sync + specs
Files: .progress.json, .prompt.md, CACHE_PREFIX.md, REQUIREMENTS.md, apps/api/package.json, apps/api/src/app.ts, apps/api/src/daemon/__tests__/task-executor-events.test.ts, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/auth/CONTEXT.md, apps/api/src/modules/auth/__tests__/middleware-invocation.test.ts, apps/api/src/modules/auth/__tests__/oauth.service.test.ts, apps/api/src/modules/auth/__tes

> ... (truncated)

## [Session Feature] feat(goals): add execution retry mechanism with retryCount

- **ID**: `GUI-036`
- **Source**: `guideline-GUI-036.md`
- **Created**: 2026-06-10T00:23:40.590Z

Commit: beb9cd2b
Message: feat(goals): add execution retry mechanism with retryCount
Files: apps/api/src/modules/goals/__tests__/goal-retry.test.ts, apps/api/src/modules/goals/scheduler-dispatch.ts, packages/studio-prisma/prisma/schema.prisma

## [Session Feature] feat(goals): add failure classifier + integrate with retry logic

- **ID**: `GUI-035`
- **Source**: `guideline-GUI-035.md`
- **Created**: 2026-06-10T00:32:32.617Z

Commit: 261b0f73
Message: feat(goals): add failure classifier + integrate with retry logic
Files: apps/api/src/modules/goals/__tests__/failure-classifier.test.ts, apps/api/src/modules/goals/__tests__/goal-retry.test.ts, apps/api/src/modules/goals/failure-classifier.ts, apps/api/src/modules/goals/scheduler-dispatch.ts

## [Session Feature] feat(skill): intent-router 意图路由 + intentKeywords 字段

- **ID**: `GUI-020`
- **Source**: `guideline-GUI-020.md`
- **Created**: 2026-06-12T07:52:49.188Z

Commit: 6de59b65
Message: feat(skill): intent-router 意图路由 + intentKeywords 字段
Files: packages/studio-skill/src/__tests__/intent-router.test.ts, packages/studio-skill/src/index.ts, packages/studio-skill/src/intent-router.ts, packages/studio-skill/src/loader.ts, packages/studio-skill/src/types.ts

## [Session Feature] feat(SP-004): SDD 文件读取替代 DB — 管线消费者迁移 Step 3

- **ID**: `GUI-017`
- **Source**: `guideline-GUI-017.md`
- **Created**: 2026-06-12T20:03:19.329Z

Commit: cea772b8
Message: feat(SP-004): Step 7-10 — DB 迁移 + 消费方迁移 + Doc Freshness + 历史提取
Files: apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/channels/requirements-doc.routes.ts, apps/api/src/modules/sdd/__tests__/sdd-freshness.service.test.ts, apps/api/src/modules/sdd/sdd-freshness.service.ts, apps/api/src/modules/wiki/wiki.routes.ts, docs/roadmap.md, docs/specs/design/SP-004-sdd-knowledge-architecture.md, packages/studio-shared/src/utils/__tests__/sdd-utils.test.ts, pac

> ... (truncated)

## [Session Feature] feat(SP-004): Step 5 Executor TDD + Step 6 CHANGELOG auto-gen

- **ID**: `GUI-016`
- **Source**: `guideline-GUI-016.md`
- **Created**: 2026-06-12T22:42:57.122Z

Commit: 137337d3
Message: feat(SP-004): Step 5 Executor TDD + Step 6 CHANGELOG auto-gen
Files: apps/api/src/modules/channels/channel.routes.ts, apps/api/src/modules/goals/goal-lifecycle.ts, apps/api/src/modules/wiki/wiki.routes.ts, packages/studio-agent/src/services/__tests__/agent-runner-sdd-task.test.ts, packages/studio-agent/src/services/__tests__/agent-runner.test.ts, packages/studio-agent/src/services/agent-runner.ts, packages/studio-agent/src/services/worktree-resolver.ts, packages/studio-

> ... (truncated)

## [Session Fix] fix: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input

- **ID**: `GUI-010`
- **Source**: `guideline-GUI-010.md`
- **Created**: 2026-05-27T08:05:24.134Z

Commit: 403d82df
Message: fix: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input
Files: apps/api/src/modules/pmo/okr.service.ts
Pattern: B8 cacheHitRate 公式修正 — cacheHit/(cacheHit+input) 替代 cacheHit/input
Triggers: single-file(apps/api/src/modules/pmo/okr.service.ts)

## [Session Fix] fix: O2-KR1 注入命中率接线 — consumption 事件 + metric query

- **ID**: `GUI-028`
- **Source**: `guideline-GUI-028.md`
- **Created**: 2026-06-11T02:47:18.771Z

Commit: 36a91ee2
Message: fix: O2-KR1 注入命中率接线 — consumption 事件 + metric query
Files: apps/api/src/modules/goals/scheduler-dispatch.ts, apps/api/src/modules/knowledge/consumers/prompt-builder.ts, apps/api/src/modules/knowledge/knowledge-service.ts, apps/api/src/modules/pmo/okr.service.ts, docs/pending-issues-2026-06-11.md
Pattern: O2-KR1 注入命中率接线 — consumption 事件 + metric query
Triggers: multi-file

## [Session Fix] fix: replace uuid with crypto.randomUUID — no external dep

- **ID**: `GUI-012`
- **Source**: `guideline-GUI-012.md`
- **Created**: 2026-05-27T08:05:24.438Z

Commit: 40a43295
Message: fix: replace uuid with crypto.randomUUID — no external dep
Files: packages/studio-task/src/services/task-queue.ts, packages/studio-task/src/services/task-worker.ts
Pattern: replace uuid with crypto.randomUUID — no external dep
Triggers: few-files

## [Session Fix] fix: review pipeline — diff scope + discoveredIssues exposure

- **ID**: `GUI-027`
- **Source**: `guideline-GUI-027.md`
- **Created**: 2026-06-11T01:34:32.677Z

Commit: 309f6061
Message: fix: review pipeline — diff scope + discoveredIssues exposure
Files: apps/api/src/modules/agents/review-agent.service.ts, apps/api/src/modules/goals/__tests__/pipeline-utils.test.ts, apps/api/src/modules/goals/__tests__/role-skill-binding.test.ts, apps/api/src/modules/goals/goal-review.ts, apps/api/src/modules/goals/pipeline-utils.ts, apps/api/src/modules/skills/CONTEXT.md, apps/api/src/modules/tools-std/CONTEXT.md, packages/studio-prisma/prisma/migrations/2026061000000

> ... (truncated)

## [Session Fix] fix: skill-loader trigger normalization + SKILL.md generation

- **ID**: `GUI-026`
- **Source**: `guideline-GUI-026.md`
- **Created**: 2026-06-11T00:24:11.255Z

Commit: adb7a9c2
Message: fix: skill-loader trigger normalization + SKILL.md generation
Files: apps/api/src/modules/skills/skill-loader.ts, apps/api/src/modules/tools-std/skill-extraction.service.ts
Pattern: skill-loader trigger normalization + SKILL.md generation
Triggers: few-files

## [Triage Fix] env_error (critical)

- **ID**: `GUI-033`
- **Source**: `guideline-GUI-033.md`
- **Created**: 2026-06-09T11:19:48.592Z

env_error (critical)
Incident: I-20260613-7cu9

## [Triage Fix] Minor issue, auto-resolved without action

- **ID**: `GUI-039`
- **Source**: `guideline-GUI-039.md`
- **Created**: 2026-06-09T08:39:43.552Z

Minor issue, auto-resolved without action
Incident: I-20260609-cf48

## [Triage Fix] timeout (critical)

- **ID**: `GUI-003`
- **Source**: `guideline-GUI-003.md`
- **Created**: 2026-05-23T02:08:23.282Z

timeout (critical)
Incident: I-20260614-gi2k

## [Triage Fix] timeout (degraded)

- **ID**: `GUI-032`
- **Source**: `guideline-GUI-032.md`
- **Created**: 2026-06-10T01:46:24.394Z

timeout (degraded)
Incident: I-20260612-gq3u

## [Triage Fix] vendor_error (degraded)

- **ID**: `GUI-034`
- **Source**: `guideline-GUI-034.md`
- **Created**: 2026-06-10T00:37:37.672Z

vendor_error (degraded)
Incident: I-20260610-8yeb

## [行为蒸馏] test-fix skill固化

- **ID**: `GUI-031`
- **Source**: `guideline-GUI-031.md`
- **Created**: 2026-06-09T13:40:14.812Z

来源: 用户行为分析 (automation)
证据: 「是不是需要一个skill」→ 创建 `~/.claude/skills/test-fix/SKILL.md`
模式: 用户总结有效工作流后立即要求固化可复用的 skill，替代被动 memory。偏好主动技能而非被动提醒。
建议动作: create_skill

## >-

- **ID**: `GUI-013`
- **Source**: `guideline-GUI-013.md`
- **Created**: 2026-06-10T09:27:48.401Z

SKILLS_DIR 定义参考: apps/api/src/modules/skills/skill-loader.ts:L65（相同 env + fallback）

## >-

- **ID**: `GUI-014`
- **Source**: `guideline-GUI-014.md`
- **Created**: 2026-06-12T01:39:08.040Z

parseFrontmatter 嵌套解析参考：loader.ts L85-94 现有 key:value 解析 + scheduler-prompt.ts L55-64 相同模式

## >-

- **ID**: `GUI-038`
- **Source**: `guideline-GUI-038.md`
- **Created**: 2026-06-09T09:26:12.092Z

authStore.ts L200-L208 — partialize pattern: persists token, refreshToken, user, session, guestId

## >-

- **ID**: `GUI-041`
- **Source**: `guideline-GUI-041.md`
- **Created**: 2026-06-08T18:47:43.991Z

参考 scripts/seed-admin.ts:L7-L8 现有 import 模式

## >-

- **ID**: `GUI-340`
- **Source**: `guideline-GUI-340.md`
- **Created**: 2026-05-24T06:18:07.910Z

OAuthAccount 必须 @@unique([provider, providerAccountId]) — 防止同一 OAuth 账户绑定多个 User

## >-

- **ID**: `GUI-341`
- **Source**: `guideline-GUI-341.md`
- **Created**: 2026-05-24T06:18:08.604Z

RefreshToken.family 用于实现 token rotation — 同 family 的所有 token 共享，检测到已 revoked 则整个 family 失效（防重放）

## >-

- **ID**: `GUI-345`
- **Source**: `guideline-GUI-345.md`
- **Created**: 2026-05-24T06:18:11.619Z

参考 oauth.service.ts:L232-L315 三路径用户查找/创建模式

## >-

- **ID**: `GUI-355`
- **Source**: `guideline-GUI-355.md`
- **Created**: 2026-05-24T07:28:04.346Z

SQLite 不支持 ADD COLUMN NOT NULL + DEFAULT — emailVerified=nullable 是正确的

## >-

- **ID**: `GUI-357`
- **Source**: `guideline-GUI-357.md`
- **Created**: 2026-05-24T07:28:05.142Z

auth.ts 需独立 import jsonwebtoken + JWT_SECRET — 不能通过 verifyToken 返回的错误类型判断（verifyToken 返回 null 吞掉具体错误）

## >-

- **ID**: `GUI-365`
- **Source**: `guideline-GUI-365.md`
- **Created**: 2026-05-24T10:48:28.052Z

try/catch 包裹保留 — eventBus 处理失败必须 non-blocking

## >-

- **ID**: `GUI-366`
- **Source**: `guideline-GUI-366.md`
- **Created**: 2026-05-24T10:48:28.505Z

不可删除: preferenceObserver.updateFromToolTrace (L173-179) — 与 eventBus 在同一 try/catch 外，独立的用户偏好更新逻辑

## >-

- **ID**: `GUI-367`
- **Source**: `guideline-GUI-367.md`
- **Created**: 2026-05-24T10:48:28.934Z

不可删除: studio.jsonl trace write (L151-170) — 审计日志，Monitor/调试依赖

## >-

- **ID**: `GUI-368`
- **Source**: `guideline-GUI-368.md`
- **Created**: 2026-05-24T10:48:29.428Z

recordCall L143: 未注册的工具调用 recordCall 时 return — 测试必须先 register

## >-

- **ID**: `GUI-377`
- **Source**: `guideline-GUI-377.md`
- **Created**: 2026-05-24T11:22:16.571Z

OAuthAccount @@unique([provider, providerAccountId]) — 唯一约束防止同一 OAuth 账户绑定多个 User

## >-

- **ID**: `GUI-386`
- **Source**: `guideline-GUI-386.md`
- **Created**: 2026-05-24T12:12:15.928Z

⚠️ L197 require('../../core/event-bus.js') 解析到 apps/api/src/core/event-bus.js → 该文件不存在（apps/api/src/core/ 仅含 database.ts + event-store.ts）

## >-

- **ID**: `GUI-390`
- **Source**: `guideline-GUI-390.md`
- **Created**: 2026-05-24T12:12:17.998Z

⚠️ 每个测试唯一工具名 (__test_record_xxx) + afterEach unregister — 防跨测污染

## |-

- **ID**: `GUI-021`
- **Source**: `guideline-GUI-021.md`
- **Created**: 2026-06-12T02:22:04.287Z

Agent: executor
Success: true
Duration: 2549160ms
Consumed: rule:default_cancel_poll, rule:default_timeout, rule:default_max_turns, rule:max_restarts_per_hour, rule:max_triage_time_ms, rule:max_fix_attempts, rule:max_retries, rule:max_concurrent, rule:min_samples, rule:env:default_execution_timeout, rule:env:max_execution_timeout, pref:user, env:current, GUI-014, GUI-056, GUI-065, GUI-075, PIT-003

## Anthropic API Key 隔离缓存池的最佳实践

- **ID**: `GUI-136`
- **Source**: `guideline-GUI-136.md`
- **Created**: 2026-05-31T16:39:21.103Z

根因：Anthropic API 的 prompt 缓存是 key 级别的，Studio 开发会话和管线执行使用同一个 key 会导致缓存互相覆盖，降低命中率。
责任归属：初始设计未考虑缓存隔离。
预防措施：为管线分配独立的 `PIPELINE_API_KEY`，在管线启动时覆盖 `STUDIO_API_KEY`，实现缓存池隔离。知识提取使用 `KNOWLEDGE_API_KEY`（可选，不设则复用 Studio key）。

## Integration影响范围测试替代全量测试

- **ID**: `GUI-015`
- **Source**: `guideline-GUI-015.md`
- **Created**: 2026-06-13T03:37:58.324Z

根因：全量测试耗时2-5分钟，是p90延迟瓶颈。实际上只需测试变更文件影响范围。责任归属：Integration阶段设计为全量测试是偷懒做法。预防措施：使用findImpactedTests()函数，通过git diff --name-only获取变更文件列表，匹配同目录.test.ts文件，只运行这些测试。全量测试仅在发布前作为release gate。tsc使用--incremental模式+复制.tsbuildinfo，从5-15秒压缩到~5秒。

## safeIngest 成功时需输出 maturity 和 sourceRefs 日志

- **ID**: `GUI-132`
- **Source**: `guideline-GUI-132.md`
- **Created**: 2026-05-31T14:42:21.558Z

根因：safeIngest 成功时无日志，无法追踪每条 entry 的 maturity 值、是否触发了去重合并（sourceReferences.length > 1 表示 merge 发生）。
责任归属：safeIngest 函数缺少成功日志。
预防措施：在 safeIngest 成功时输出 `Entry ingested: id, maturity, sourceReferences.length`，便于调试和验证 maturity 修复是否生效。

## 废弃 API 端点应返回 410 Gone 而非静默保留

- **ID**: `GUI-096`
- **Source**: `guideline-GUI-096.md`
- **Created**: 2026-06-02T12:49:10.216Z

根因：`generatePlan`、`approvePlan`、`execute` 三个端点已无前端消费方（Channel 流程绕过它们直接创建 Goal+Execution），但代码仍存在，可能误导未来开发者。
责任归属：架构决策未及时清理废弃 API。
预防措施：确认无消费方后，将废弃端点改为返回 410 Gone（Gone），并记录废弃原因。不删除代码（保留历史），但阻止新调用。

## 测试中模块级 `require()` 应懒加载以避免 ESM 解析失败

- **ID**: `GUI-101`
- **Source**: `guideline-GUI-101.md`
- **Created**: 2026-06-05T10:14:29.705Z

根因：`database.ts` 在模块加载时立即 `require('studio-skill')`，但 vitest 的 ESM 转换尚未就绪，导致所有测试都触发解析错误。
责任归属：模块作者应避免在模块顶层执行可能触发 ESM 解析的 `require()` 调用。
预防措施：将 `require()` 移至函数内部懒加载，或使用动态 `import()` 替代。

## 知识沉淀质量审核需关注类型分布和内容完整性

- **ID**: `GUI-131`
- **Source**: `guideline-GUI-131.md`
- **Created**: 2026-05-31T14:10:21.059Z

根因：沉淀产出 94% 为 guideline 类型，37 条 session 条目全部无 content（只有标题），导致知识不可消费。责任归属：提取逻辑未约束输出格式——LLM 返回的条目缺少根因/决策/场景等字段。预防措施：1) 在 extract-text 的 prompt 中明确要求输出 content 包含根因、责任归属、预防措施；2) 增加类型分布监控，确保 pitfall/architecture/process 占比不低于 20%；3) 对 content 为空或过短的条目做过滤或重新提取。

## 验证环境应使用独立测试数据避免污染

- **ID**: `GUI-139`
- **Source**: `guideline-GUI-139.md`
- **Created**: 2026-05-31T18:15:45.528Z

根因：端到端验证使用生产或共享数据，导致测试结果受数据状态影响（如重复、过期），且可能干扰生产环境。责任归属：运维团队未隔离测试环境，开发人员未提供测试数据生成脚本。预防措施：为端到端验证创建独立测试数据集（如合成文本和向量），并在验证前后自动清理；使用Docker Compose或Kubernetes隔离验证环境。
